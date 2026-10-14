/**
 * dont-stop — Loop engine.
 *
 * The engine owns the loop: it discovers models, builds a plan per agent and
 * task, applies it through both channels, watches events, and recovers from
 * failures. It holds no I/O of its own beyond what it is handed, so it can be
 * reasoned about as a state machine.
 *
 * Lifecycle: `start()` arms the loop on a session, the heartbeat evaluates it
 * on the interval, events feed the clocks and the session tracker, and
 * `stop()` disarms it.
 *
 * Two rules keep it from running away, and both come from the same idea —
 * *the loop may only touch what it owns*:
 *
 * - **Ownership.** A loop belongs to the instance that started it (`owner`).
 *   Advancing, interrupting and rotating happen only there, so a second live
 *   opencode process reports a loop but never drives it. A loop left behind by
 *   a dead owner is recovered on boot: adopted when its session still exists,
 *   halted when it does not.
 * - **A budget per failure, not per recovery.** Every model gets one try per
 *   episode — rotation moves to a model that has not been attempted since the
 *   last completed turn, so a chain of ten is walked and then stops instead of
 *   being cycled. Rotations are also counted against completed turns, so a
 *   wide chain cannot buy an unbounded number of losing bets either.
 */

import {
  applyAvailability,
  applyCooldowns,
  loadCatalogue,
  markAvailable,
  markUnavailable,
  cooldown,
  clearCooldown,
  filter,
  slotKey,
  sortBy,
  sorts,
  exportSummary,
  HARDWARE_4090,
  type AvailabilityPatch,
  type Catalogue,
  type CatalogueModel,
  type HardwareProfile,
  type Requirements,
} from "./catalogue.ts"
import {
  AGENT_KINDS,
  profileFor,
  rankForMode,
  type AgentKind,
  type TaskProfile,
} from "./modes.ts"
import { actionFor, classify, DEPRECATED_COOLDOWN_MS, FUNDS_PROVIDER_WINDOW_MS, PERMANENT_COOLDOWN_MS, type ClassifiedError, type ErrorAction } from "./errors.ts"
import { ClockSet, DEFAULT_CLOCKS, type ClockOptions } from "./clocks.ts"
import {
  DEFAULT_ROTATION_THRESHOLD,
  effectiveContext,
  measureContext,
  ollamaServedContext,
  rotate,
  shouldRotate,
  sessionTree as fetchSessionTree,
  type RotationContext,
} from "./rotation.ts"
import { applyAgentDefaults, applySessionModels, sameSlot, slotFrom, type ApplyContext, type ModelPlan } from "./apply.ts"
import type { Logger } from "./log.ts"
import { bumpIntent, MODES, readState, type LoopState, type Mode, type ModelSlot, type PluginState } from "./state.ts"
import { eventSignals, TURN_END_TYPES, type EventError, type SessionEvent } from "./events.ts"

/** A session the engine is tracking for the loop. */
export interface TrackedSession {
  sessionID: string
  lastSeen: number
  /** The model currently pinned on the session, when known. */
  model: ModelSlot | null
  /** The agent the session is running as. */
  agent: string
}

export interface EngineOptions {
  clocks?: ClockOptions
  /** Called when the engine changes something the TUI should show. */
  onStateChange?: (state: PluginState) => void
  /** Session ids to track, for tests. */
  seedSessions?: string[]
  /** Hard cap on iterations, so a loop cannot run forever. */
  maxIterations?: number
  /** Fraction of the effective context window at which to rotate. */
  rotationThreshold?: number
  /** Turns in one session before a fresh one is started. */
  sessionSteps?: number
  /** How often to re-inject the full loop prompt into an active session.
   *  Reinjection keeps the mission in front of the model once per-turn
   *  instructions age out of attention (or get summarized by compaction).
   *  The countdown measures turns since the last restatement, wherever that
   *  happened — cadence, stagnant turn, or a re-drive. */
  reinjectEvery?: number
  /** Identifies this process as the loop's owner. Generated when omitted. */
  instanceID?: string
  /**
   * The machine's GPU profile for local fit checks. Defaults to the 4090
   * figure; set `DONT_STOP_VRAM_GB` in the environment (index.ts builds this
   * from it) so an 8GB laptop card excludes models that cannot load there.
   */
  hardware?: HardwareProfile
  /**
   * Delay before re-driving the loop after cancelling a hung turn: the abort
   * needs a moment to settle before the next prompt lands.
   */
  redriveDelayMs?: number
  /**
   * Delay before re-driving after a *failed* turn. The turn is already over,
   * so the loop can walk to the next model almost immediately instead of
   * waiting out the hang-settle delay.
   */
  failureRedriveDelayMs?: number
  /** How long a model that hung stays out of the chain. */
  hangCooldownMs?: number
  /**
   * Boot window in which the restart detector stands down, so a re-seed does
   * not race opencode's own session resume after a service restart. Defaults
   * to DEFAULT_RESEED_GRACE_MS; tests pass 0.
   */
  reseedGraceMs?: number
}

/**
 * The iteration count at which the loop reports a runaway.
 *
 * A report, not a bound (owner, 2026-10-11): loops end only when their owner
 * halts them, so crossing this line logs a warning and continues — the
 * counter exists so a runaway is visible in the footer, not so it can stop.
 */
export const DEFAULT_MAX_ITERATIONS = 100

/**
 * Turns in one session before the loop rotates to a fresh one.
 *
 * A long conversation degrades the model at the work, not just its speed, and
 * a new session with the same prompt cures it. This budget is the backstop for
 * a conversation that never otherwise settles.
 */
export const DEFAULT_SESSION_STEPS = 30

/**
 * How many turns between scheduled full-prompt reinjections.
 *
 * The model drifts once the opening instructions age out of attention or get
 * summarized by compaction, so the mission is restated on this cadence — and
 * sooner when a turn ends with no tool activity, when a compaction just ran,
 * or when a re-drive follows an interrupt, failure or restart. The countdown
 * measures turns since the last restatement, so those earlier triggers start
 * it over. Between restatements a short nudge is enough while the context
 * still holds the task.
 */
export const DEFAULT_REINJECT_EVERY = 10

/**
 * How long to wait before re-driving the loop — after cancelling a hung turn,
 * or before a second attempt on a model that just failed.
 *
 * Two situations, one delay, because both are "wait a moment and try again on
 * this session" and neither wants to be tuned without the other. The hang case
 * is the one that would otherwise be fatal: an aborted request never emits the
 * idle event the loop is normally driven by, so without this the loop would
 * sit silently forever after its first hang — which is exactly what it did.
 * The delay gives the host time to settle the abort; if a real turn starts in
 * the meantime, the redrive stands down and the normal idle path takes over.
 */
export const DEFAULT_REDRIVE_DELAY_MS = 20_000

/**
 * How soon a failed turn is re-driven on the freshly rotated model.
 *
 * A failure event means the turn is over, so unlike the hang path there is
 * nothing to settle: the loop walks to the next model almost immediately.
 * Sharing the hang path's 20s (plus a heartbeat that could add 30 more) is
 * what made a five-model walk take minutes — the owner watched the model
 * switch and then silence until the re-drive's prompt finally arrived.
 */
export const DEFAULT_FAILURE_REDRIVE_DELAY_MS = 1_500

/**
 * How long a re-drive waits before re-checking a session that was still
 * running when the deadline passed. Short, because the wait is for a turn to
 * finish settling, not for a provider.
 */
export const REDRIVE_POLL_MS = 1_000

/**
 * The grace added to every re-drive timer, so it fires after its deadline.
 *
 * `setTimeout` is measured on libuv's clock, while the deadline it is racing
 * is `Date.now()`; the two do not agree to the millisecond, and a timer
 * observed firing 1ms early makes `maybeRedrive` read the re-drive as not yet
 * due — which, without this, spent the full poll tick waiting for a moment
 * that had already arrived.
 */
export const REDRIVE_TIMER_GRACE_MS = 1

/** How long a model that hung stays out of the chain (10 minutes). */
export const DEFAULT_HANG_COOLDOWN_MS = 10 * 60_000

/**
 * How long after boot the restart detector stands down.
 *
 * A service restart resumes suspended sessions and re-appends instruction
 * messages, so a session's message count can be in flux while opencode settles.
 * A re-seed that races opencode's own resume is a duplicate prompt, not a
 * recovery, and the wait costs nothing: the resume is already re-driving the
 * session. Tests pass 0 to exercise the detector directly.
 */
export const DEFAULT_RESEED_GRACE_MS = 90_000

/**
 * How long a loop session waits before a second compaction request.
 *
 * Compaction is requested when no candidate model can hold the session's
 * context, or when the transcript carries provider state the endpoint no
 * longer honors (a stale reasoning item); the server compacts at the next
 * step boundary. After one request the transcript is on its way down, so a
 * second request within the window is a duplicate, not a new need.
 */
export const COMPACTION_REQUEST_COOLDOWN_MS = 5 * 60_000

/**
 * The served context assumed for a local model whose window the daemon does
 * not report (it is not loaded). `OLLAMA_CONTEXT_LENGTH` on this machine is
 * 64000, a fraction of the native figures in the catalogue — assuming the
 * native window would let a 200k session land on a model that truncates
 * every prompt it receives.
 */
export const LOCAL_WINDOW_UNKNOWN_GUARD = 64_000

/**
 * How recent an interrupt must be to count as the hang path's own doing.
 *
 * The hang path records the moment it interrupts; the resulting
 * `session.execution.interrupted` event can arrive a beat later, so the check
 * is a small recency window rather than an exact match.
 */
export const HANG_INTERRUPT_RECENCY_MS = 5_000

/**
 * How long before a loop session may interrupt for a retry storm again.
 *
 * After one cut the turn is re-driven (the loop continues on a fresh model),
 * so a window longer than the re-drive delay means the *next* turn's retry is
 * a new failure, not the same storm being observed twice.
 */
export const RETRY_INTERRUPT_COOLDOWN_MS = 45_000

/** Heartbeat intervals an owner may miss before its loop counts as orphaned. */
export const LEASE_GRACE_BEATS = 3

/**
 * The loop drive prompt.
 *
 * Short — just tells the model to keep going. No sentinels, no boundary
 * tokens, no completion protocol. It is enough only while the model is
 * visibly working (the turn that ends used a tool); the full mission is
 * restated by `missionText` whenever attention may have faded — the cadence,
 * a stagnant turn, and every re-drive after an interruption, failure,
 * compaction or restart.
 */
export const CONTINUE_PROMPT = "Continue."

/**
 * The full mission, restated: the loop's own prompt plus the keep-going
 * instruction.
 *
 * Built in one place because more than one path sends it — the cadence and
 * stagnation paths in `advance`, and the re-drive path after an interrupted
 * or failed turn — and a drift in any one of them would mean a different
 * mission reaches the model.
 */
export function missionText(prompt: string): string {
  return `${prompt}\n\nKeep working.`
}

/** What a scheduled re-drive carries: the short nudge or the full mission. */
export type RedriveKind = "nudge" | "mission"

/**
 * A pending re-drive: the deadline and the strength of the prompt owed.
 *
 * An interruption, a failure, a compaction or a restart all take the mission
 * out of the model's immediate attention — the abort killed the turn that was
 * carrying it, or compaction summarized it away — so the re-drive restates
 * the full mission by default. The one exception is the same-model retry of a
 * transient failure: the transcript is intact and the request that just died
 * is already the last thing on it, so a nudge is the honest continuation.
 */
export interface Redrive {
  /** Epoch ms at which the prompt may be sent. */
  at: number
  kind: RedriveKind
}

/**
 * What a rotation attempt did.
 *
 * `"moved"` is the only success. `"exhausted"` and `"unavailable"` mean the
 * chain has nothing left and the caller should stop the loop; `"not-ours"`
 * means the session is not the loop's own and the caller should do nothing at
 * all — which is why this is not a boolean, since those three failures want
 * three different reactions.
 */
export type RotationOutcome = "moved" | "exhausted" | "unavailable" | "not-ours"

export class LoopEngine {
  private catalogue: Catalogue | null = null
  private readonly tracked = new Map<string, TrackedSession>()
  private readonly clocks: ClockSet
  private restrictions: Record<string, Requirements> = {}
  private tried = new Set<string>()
  private retries: Record<string, number> = {}
  /**
   * Whether the turn that just ended died of an error rather than completing,
   * per loop session (memory-only; on-disk loops carry no such flag). Cleared
   * when a prompt is sent, so `advance` can tell a finished turn from an
   * error that merely idled the session — only the former starts a fresh try
   * budget, or a failing model would get an unlimited number of retries.
   */
  private failedTurns = new Set<string>()
  /**
   * Whether a turn of a LOOP'S session is in flight, per session. Set when a
   * prompt is sent and when an execution-start event arrives; cleared by the
   * first turn-end event. Turn-end events come in pairs on the v2 bus (an
   * execution result and a later idle/status), and without this flag each pair
   * would advance the loop twice. Per-session since 2026-10-12: several
   * sessions may run loops of their own at once.
   */
  private armedSessions = new Set<string>()
  /**
   * When the hang path last interrupted each session. The interrupt
   * produces a `session.execution.interrupted` event; distinguishing it from
   * a user escape is what lets the engine stand down and let the scheduled
   * re-drive own the next prompt instead of advancing immediately.
   */
  private hangInterrupts = new Map<string, number>()
  /** When a retry storm was last cut short per loop session. */
  private retryInterrupts = new Map<string, number>()
  /** Pending re-drives per loop session, or absent. */
  private redrives = new Map<string, Redrive>()
  /**
   * Whether the current turn of a loop session has used a tool. Cleared when
   * a prompt goes out, set by a tool event, so at turn end it describes
   * exactly the turn that just ended: a completed turn that never set it
   * produced prose only — the model talking about the work instead of doing
   * it — and gets the mission restated ahead of the `reinjectEvery` cadence.
   */
  private readonly turnToolUse = new Set<string>()
  /**
   * The iteration at which each loop last had its mission restated. The
   * `reinjectEvery` cadence counts from here rather than from iteration zero,
   * so a restatement earned by a stagnant turn or a re-drive starts the
   * countdown over instead of letting a second one follow a turn later.
   */
  private readonly lastReinjections = new Map<string, number>()
  /** Timers that wake the engine at a re-drive deadline instead of the beat. */
  private redriveTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * This process's identity. Written into the state file as the loop's owner,
   * it is what lets a second instance — or a new one after a restart — know
   * that a loop it finds on disk belongs to somebody else.
   */
  readonly instanceID: string
  /** Newest control intent this engine has acted on, so its own are not replayed. */
  private appliedIntent: number
  /** Last announced reachability counts, so a re-check logs only on change. */
  private reachabilityCount: { reachable: number; unroutable: number } | null = null
  /** Guards against sending two prompts for one idle event, per loop session. */
  private advancing = new Set<string>()
  /** Whether a foreign loop has already been reported, so it is said once. */
  private reportedForeignLoop = false
  /**
   * When this engine loaded. The restart detector stands down for a short
   * window after boot (`reseedGraceMs`) because a service restart resumes
   * sessions through opencode's own machinery.
   */
  private readonly startedAt = Date.now()

  private readonly maxIterations: number
  private readonly rotationThreshold: number
  private readonly sessionSteps: number
  private readonly reinjectEvery: number
  private readonly redriveDelayMs: number
  private readonly failureRedriveDelayMs: number
  private readonly hangCooldownMs: number
  private readonly leaseGraceMs: number
  private readonly reseedGraceMs: number
  /** The machine's GPU profile for local fit checks. */
  private readonly hardware: HardwareProfile
  /**
   * When each loop session last compacted. Compaction removes messages, which
   * otherwise reads as a session restart; the restart detector stands down
   * within a window of a compaction because compaction preserves the work.
   */
  private readonly compactions = new Map<string, number>()
  /**
   * The last observed message count per LOOP session, used to detect a
   * session that was restarted underneath the engine (the count drops when
   * the conversation is cleared and the loop would otherwise wait forever).
   * Baseline is set when a prompt is sent and refreshed on every beat.
   */
  private readonly messageCounts = new Map<string, number>()
  /** When a compaction was last requested per loop session (epoch ms). */
  private readonly compactionRequests = new Map<string, number>()

  constructor(
    private readonly ctx: ApplyContext,
    private readonly state: PluginState,
    private readonly log: Logger,
    private readonly options: EngineOptions = {},
  ) {
    const clocks = options.clocks ?? DEFAULT_CLOCKS
    this.clocks = new ClockSet(clocks, log)
    this.instanceID = options.instanceID ?? newInstanceID()
    this.appliedIntent = state.intent?.seq ?? 0
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
    this.rotationThreshold = options.rotationThreshold ?? DEFAULT_ROTATION_THRESHOLD
    this.sessionSteps = options.sessionSteps ?? DEFAULT_SESSION_STEPS
    this.reinjectEvery = options.reinjectEvery ?? DEFAULT_REINJECT_EVERY
    this.redriveDelayMs = options.redriveDelayMs ?? DEFAULT_REDRIVE_DELAY_MS
    this.failureRedriveDelayMs = options.failureRedriveDelayMs ?? DEFAULT_FAILURE_REDRIVE_DELAY_MS
    this.hangCooldownMs = options.hangCooldownMs ?? DEFAULT_HANG_COOLDOWN_MS
    this.reseedGraceMs = options.reseedGraceMs ?? DEFAULT_RESEED_GRACE_MS
    this.hardware = options.hardware ?? HARDWARE_4090
    this.leaseGraceMs = clocks.intervalMs * LEASE_GRACE_BEATS
    for (const id of options.seedSessions ?? []) {
      this.track(id)
    }
  }

  /* ------------------------------------------------------------- accessors */

  /**
   * The loop the whole-plugin surface reports: the newest ACTIVE loop, else
   * the newest stopped one, else null. Per-session loops live in
   * `state.loops`; this is only the one-line answer.
   */
  get status(): LoopState | null {
    return this.primaryLoop()
  }

  /** The loop the global surfaces (footer, agent defaults) follow. */
  primaryLoop(): LoopState | null {
    const loops = Object.values(this.state.loops)
    if (loops.length === 0) return null
    const active = loops.filter((l) => l.status === "active")
    const pool = active.length > 0 ? active : loops
    return [...pool].sort(
      (a, b) => (b.ownerBeatAt || b.startedAt || 0) - (a.ownerBeatAt || a.startedAt || 0),
    )[0]
  }

  get mode(): Mode {
    return this.state.mode
  }

  get model(): Catalogue | null {
    return this.catalogue
  }

  trackedSessions(): TrackedSession[] {
    return [...this.tracked.values()]
  }

  /** Every loop record, in insertion order. */
  loops(): LoopState[] {
    return Object.values(this.state.loops)
  }

  /** The loop record of one session, when it has one. */
  loopFor(sessionID: string): LoopState | undefined {
    return this.state.loops[sessionID]
  }

  /**
   * May this instance drive THAT session's loop?
   *
   * The single gate for every loop action — advancing, interrupting,
   * rotating, re-driving. A loop is a live conversation with requests in
   * flight, so it cannot be resumed by whoever reads the state file next;
   * only its owner acts, and everyone else reports.
   */
  ownsLoop(sessionID: string): boolean {
    const loop = this.state.loops[sessionID]
    return !!loop && loop.status === "active" && loop.sessionID === sessionID &&
      loop.owner === this.instanceID
  }

  /* ------------------------------------------------------------ attribution */

  /** Track a session for the loop. */
  track(sessionID: string, agent = "general"): TrackedSession {
    let record = this.tracked.get(sessionID)
    if (!record) {
      record = { sessionID, lastSeen: Date.now(), model: null, agent }
      this.tracked.set(sessionID, record)
    } else {
      record.lastSeen = Date.now()
      record.agent = agent
    }
    this.clocks.clocksFor(sessionID)
    return record
  }

  untrack(sessionID: string): void {
    this.tracked.delete(sessionID)
    this.clocks.forget(sessionID)
  }

  /** Feed an event into the clocks and the session tracker. */
  observe(event: SessionEvent): void {
    const signals = eventSignals(event)
    const sessionID = signals.sessionID
    if (!sessionID) return

    this.track(sessionID)

    const clocks = this.clocks.clocksFor(sessionID)
    const now = Date.now()

    if (signals.progress) clocks.progress(now)
    else clocks.seen(now)

    if (signals.lifecycle === "start") {
      clocks.start(now)
      // A started turn is a turn in flight: the first turn-end event for a
      // loop's session is the one that gets to advance it.
      if (this.loopFor(sessionID)) this.armedSessions.add(sessionID)
      const record = this.tracked.get(sessionID)
      if (record) {
        if (signals.model) record.model = signals.model
        if (signals.agent) record.agent = signals.agent
      }
    } else if (signals.lifecycle === "finish") {
      clocks.finish(now)
    } else {
      // Metadata events (created, updated, model/agent selected) refresh the
      // tracked record without moving the clocks.
      const record = this.tracked.get(sessionID)
      if (record) {
        if (signals.model) record.model = signals.model
        if (signals.agent) record.agent = signals.agent
      }
    }

    // Tool use is the work. A turn that ends without any is the stagnant
    // state the mission restatement exists for, so it is recorded against
    // the turn now in flight. Only loop sessions matter.
    if (signals.progress === "tool" && this.state.loops[sessionID]) {
      this.turnToolUse.add(sessionID)
    }

    this.state.lastEvent = event.type

    // Compaction removes messages but preserves the work: remember it so the
    // restart detector does not mistake a compacted session for a cleared one.
    if (event.type === "session.compacted") this.compactions.set(sessionID, Date.now())
  }

  /* --------------------------------------------------------------- turn end */

/**
   * A turn of the loop's session ended. This is the driver hook the server
   * entrypoint calls on the turn-end events; the loop continues by advancing,
   * unless the ending was the hang path's own interrupt, in which case the
   * scheduled re-drive owns the next prompt.
   *
   * Only the `session.execution.*` trio drives the loop (see
   * `TURN_END_TYPES`): they are exactly one per turn, while the idle/status
   * events that trail an execution result would double-advance it.
   */
  async onTurnEnd(sessionID: string, eventType: string): Promise<void> {
    if (!TURN_END_TYPES.has(eventType)) return
    if (!this.ownsLoop(sessionID)) return
    if (!this.armedSessions.has(sessionID)) return
    this.armedSessions.delete(sessionID)

    if (eventType === "session.execution.interrupted") {
      // An interrupt ends a turn without completing it. When it was ours —
      // the hang path interrupting before a rotation — the re-drive deadline
      // owns the next prompt, and advancing now would double-drive. When it
      // was the user's escape, nothing else is scheduled, so the re-drive
      // gives the loop a moment before continuing it.
      const ours = Date.now() - (this.hangInterrupts.get(sessionID) ?? 0) < HANG_INTERRUPT_RECENCY_MS
      const loop = this.loopFor(sessionID)
      if (loop) loop.turnStartedAt = null
      if (ours) return
      if (!this.redrives.has(sessionID)) this.scheduleRedrive(sessionID, this.redriveDelayMs)
      return
    }

    await this.advance(sessionID)
  }

  /* ------------------------------------------------------------ session tree */

  /** The loop session and every descendant session, at any depth. */
  private async sessionTree(rootID: string): Promise<string[]> {
    const ctx = this.ctx as unknown as Pick<RotationContext, "session">
    try {
      return [rootID, ...(await fetchSessionTree(ctx, rootID))]
    } catch {
      // The tree could not be walked; the root is still the root.
      return [rootID]
    }
  }

  /** The session ids currently running, per the server's own activity map. */
  private async activeSessionIDs(): Promise<Set<string>> {
    try {
      const api = this.ctx as unknown as {
        session: { active(): Promise<unknown> }
      }
      const active = await api.session.active()
      const ids = new Set<string>()
      if (Array.isArray(active)) {
        for (const entry of active) {
          if (typeof entry === "string") ids.add(entry)
          else if (entry && typeof entry === "object") {
            const id = (entry as Record<string, unknown>).id ?? (entry as Record<string, unknown>).sessionID
            if (typeof id === "string") ids.add(id)
          }
        }
      } else if (active && typeof active === "object") {
        const data = (active as Record<string, unknown>).data
        for (const key of Object.keys(data && typeof data === "object" ? data : active)) ids.add(key)
      }
      return ids
    } catch {
      return new Set()
    }
  }

  /**
   * Interrupt the loop session and every live descendant: a subagent running
   * when its parent is hung or halted keeps writing into work the loop has
   * abandoned, so the recovery has to reach the whole tree, not just the root.
   */
  private async interruptTree(rootID: string): Promise<void> {
    const tree = await this.sessionTree(rootID)
    const active = await this.activeSessionIDs()
    for (const id of tree) {
      const running = active.has(id) || this.clocks.peek(id)?.activity.running === true
      if (running) await this.interrupt(id)
    }
  }

  /* ------------------------------------------------------------ discovery */

  /**
   * Discover models by loading the generated catalogue.
   *
   * The catalogue is built by `scripts/update-catalogue.ts`, which queries
   * models.dev, the curated benchmark table, the scraped ollama popularity
   * list, and the local ollama daemon, then writes `data/catalogue.json`.
   * That is a CLI step on purpose: it is slow, network-bound, and produces a
   * committed artifact, so a plugin reload must not silently rewrite it.
   *
   * Availability is *runtime* state and is layered back on after the load, so
   * a reload does not forget which models were rate limited.
   */
  async discover(): Promise<Catalogue | null> {
    const patches = this.availabilityPatches()
    const previous = this.catalogue
    const next = loadCatalogue()
    if (!next) {
      if (!previous) {
        this.log.warn("no catalogue on disk; run: npx tsx scripts/update-catalogue.ts")
      }
      return previous
    }
    this.catalogue = next
    applyAvailability(next, patches)
    // Persisted cooldowns decide eligibility in EVERY instance, not just the
    // one that served the sentence: a fresh engine's rows carry no runtime
    // state, and without this a cooling model is ranked and picked again
    // (the "cooling models keep cycling" report). Availability patches cover
    // this engine's own memory; the state file covers everyone else's.
    applyCooldowns(next, this.state.cooldowns, Date.now())
    await this.applyReachability()
    this.log.info(`catalogue loaded: ${next.models.length} models from ${next.sources.length} sources`)
    this.emit()
    return next
  }

  /**
   * Mark which models the running OpenCode can actually route to.
   *
   * The committed catalogue carries the fetch-time view, which can be stale:
   * credentials change, providers are added and removed. The engine has an
   * authenticated context, so it re-derives reachability on every load rather
   * than trusting the file. Without this, a mode would cheerfully select a
   * model whose provider has no key — `alibaba/qwen3.7-flash` is the cheapest
   * text+tool model in models.dev and simply cannot be used here.
   *
   * A failure to list models leaves reachability untouched rather than
   * clearing it, so a transient API error cannot empty every mode.
   */
  private async applyReachability(): Promise<void> {
    if (!this.catalogue) return
    try {
      const api = this.ctx as unknown as {
        model?: { list(): Promise<{ data?: unknown }> }
        catalog?: { model: { list(): Promise<{ data?: unknown }> } }
      }
      // v2 exposes the registry at `ctx.model`; the older `ctx.catalog`
      // spelling is tolerated so a downgrade does not silently disable
      // reachability.
      const result = (await api.model?.list()) ?? (await api.catalog?.model.list())
      const data = (result as { data?: Array<{ providerID?: string; id?: string }> } | undefined)?.data
      if (!Array.isArray(data) || data.length === 0) return

      const usable = new Set(data.map((m) => `${m.providerID ?? ""}/${m.id ?? ""}`))
      let reachable = 0
      let unroutable = 0
      for (const model of this.catalogue.models) {
        model.reachable = usable.has(`${model.providerID}/${model.id}`)
        if (model.reachable) reachable++
        else unroutable++
      }
      // Announce only a change: this re-runs on a post-boot backoff and on
      // heartbeats, and a line per beat would bury the real movement.
      const before = this.reachabilityCount
      if (!before || before.reachable !== reachable || before.unroutable !== unroutable) {
        this.reachabilityCount = { reachable, unroutable }
        this.log.info(`reachability: ${reachable} routable, ${unroutable} not routable from this install`)
      }
      this.emit()
    } catch (error) {
      this.log.quiet("info", `reachability check unavailable: ${msg(error)}`)
    }
  }

  /**
   * Re-derive reachability against the live registry.
   *
   * The registry is not guaranteed complete while `setup` is still running —
   * provider definitions can still be loading — so the boot read can mark a
   * routable provider unroutable and the free sweep loses its cheapest
   * candidates. The startup backoff calls this until the count settles.
   */
  async recheckReachability(): Promise<void> {
    await this.applyReachability()
  }

  /** Capture current availability so a reload can restore it. */
  private availabilityPatches(): AvailabilityPatch[] {
    if (!this.catalogue) return []
    const patches: AvailabilityPatch[] = []
    for (const model of this.catalogue.models) {
      if (!model.available || model.cooldownUntil > Date.now()) {
        patches.push({ key: model.key, available: false, reason: model.availabilityReason ?? "unavailable" })
      }
    }
    return patches
  }

  /** Put a model on cooldown until `until` (epoch ms). */
  coolDown(key: string, until: number): void {
    if (this.catalogue) cooldown(this.catalogue, key, until)
  }

  /**
   * Cooldown through both channels: the durable state (survives reloads,
   * drives the expiry that re-admits a model) and the catalogue row itself
   * (so ranking sees it immediately). The two used to be written in different
   * places, which left a model selectable on the ranking path while its
   * cooldown entry said otherwise.
   */
  private putOnCooldown(key: string, until: number): void {
    this.state.cooldowns[key] = until
    this.coolDown(key, until)
  }

  /** Restore a model to available. */
  restore(key: string): void {
    if (this.catalogue) markAvailable(this.catalogue, key)
  }

  /** Mark a model unavailable with a reason. */
  fail(key: string, reason: string): void {
    if (this.catalogue) markUnavailable(this.catalogue, key, reason)
  }

  /* --------------------------------------------------------------- planning */

  /** The task profile for an agent kind, honouring any active restriction. */
  private taskFor(agent: string): TaskProfile {
    const kind = agentKind(agent)
    const wanted = visionWanted(kind)
    const restricted = this.restrictions[agent]
    // A restriction on vision overrides the kind's default: a session that
    // already failed on vision must not request it again.
    if (restricted && restricted.vision === false) return { ...profileFor(kind), vision: false }
    return profileFor(kind, wanted ? { vision: true } : {})
  }

  /** Build the full plan for one mode and the current catalogue. */
  buildPlan(mode: Mode = this.state.mode): ModelPlan {
    const notes: string[] = []
    const agents: Record<string, ModelSlot> = {}
    if (!this.catalogue) {
      return { main: null, agents, sessions: [], notes: ["no catalogue yet"] }
    }

    for (const kind of AGENT_KINDS) {
      const task = this.taskFor(kind)
      // The agent-default plan is for sessions that have not started, so it
      // ranks at the base price tier; a live session's tier-aware re-pick
      // happens in `refresh`/`rotate`, where its context usage is known.
      const ranked = rankForMode(this.catalogue, mode, task, this.hardware)
      if (ranked.length === 0) {
        notes.push(`${kind}: no model satisfies ${mode} requirements`)
        continue
      }
      const slot = slotFrom(ranked[0])
      agents[kind] = slot
      notes.push(`${kind}: ${slot.providerID}/${slot.id} (cap ${ranked[0].scores.capability})`)
    }

    const main = agents["general"] ?? Object.values(agents)[0] ?? null
    if (main) agents["__main__"] = main

    const sessions = [...this.tracked.keys()]
      .map((sessionID) => ({
        sessionID,
        model: agents[this.tracked.get(sessionID)?.agent ?? "general"] ?? main,
      }))
      .filter((entry): entry is { sessionID: string; model: ModelSlot } => entry.model !== null)

    return { main, agents, sessions, notes }
  }

  /* ---------------------------------------------------------------- applying */

  /**
   * Push the current plans through both channels and record the result. Safe
   * to call on every heartbeat: the plan diff keeps it quiet when nothing
   * changed.
   *
   * Two plans exist per-session (2026-10-12): the agent-defaults channel is
   * global, so it follows the PRIMARY loop's mode (the default mode when no
   * loop is active), while the session-pin channel is one entry per owned
   * loop, each planned in ITS OWN loop's mode.
   */
  async refresh(force = false): Promise<void> {
    if (!this.catalogue) {
      await this.discover()
      if (!this.catalogue) return
    }

    const primary = this.primaryLoop()
    const primaryMode = primary?.mode ?? this.state.mode
    const plan = this.buildPlan(primaryMode)

    await applyAgentDefaults(this.ctx as unknown as ApplyContext, () => plan)

    // The session channel reaches the LOOP sessions ONLY. Tracking used to be
    // incidental — `observe` records every session that emits an event — and
    // the plan then switched the pinned model of *every* tracked session,
    // which is how a free-sweep re-plan re-modelled a user's live session that
    // had nothing to do with the loop. Being tracked is not consent: this
    // plugin drives the loops it was asked to start, and nothing else.
    const needsSwitch: Array<{ sessionID: string; model: ModelSlot }> = []
    for (const loop of this.loops()) {
      if (loop.status !== "active" || loop.owner !== this.instanceID || loop.sessionID === null) continue
      const loopPlan = loop.mode === primaryMode ? plan : this.buildPlan(loop.mode)
      const target = this.tracked.get(loop.sessionID)
      const entry = loopPlan.sessions.find((e) => e.sessionID === loop.sessionID)
      if (!entry || !target) continue
      const differs = !target.model || !sameSlot(target.model, entry.model)
      if (!force && !differs) continue

      let pick = entry
      if (target.model && differs && this.catalogue) {
        // The plan was ranked at the base rate. A live session's next request
        // carries its actual context, so cheap mode re-prices the switch at
        // that size before it is applied.
        const used = !force || loop.mode === "cheap" ? await this.contextUsed(loop.sessionID) : 0
        if (used > 0 && loop.mode === "cheap") {
          const better = await this.cheapPickForContext(target.agent, used)
          if (better && sameSlot(better, target.model)) continue
          if (better) pick = { sessionID: entry.sessionID, model: slotFrom(better) }
        }
        // Context veto on the switch: a plan that now prefers a model whose
        // window cannot hold the conversation must not yank the session down
        // to it — the next turn would come back truncated. The rotation path
        // handles the "nothing fits" case by compacting; here, keeping the
        // current model is the safe answer, and the session-rotation path
        // sheds the context when the current model itself is outgrown.
        if (!force && sameSlot(pick.model, entry.model)) {
          const row = this.catalogueRowFor(entry.model)
          if (row && used > 0 && !(await this.canHoldContext(row, used))) {
            this.log.quiet(
              "info",
              `keeping ${modelKeyOf(target.model)} on ${loop.sessionID}: ` +
                `${entry.model.providerID}/${entry.model.id} cannot hold ${used} tokens of context`,
            )
            continue
          }
        }
      }
      needsSwitch.push(pick)
    }

    if (needsSwitch.length > 0 || force) {
      const result = await applySessionModels(this.ctx as unknown as ApplyContext, needsSwitch, this.log)
      for (const sessionID of result.sessionsSwitched) {
        const record = this.tracked.get(sessionID)
        if (record) {
          const entry = needsSwitch.find((e) => e.sessionID === sessionID)
          if (entry) record.model = entry.model
        }
      }
    }

    // Mirror the primary plan into state so the TUI can render it.
    this.state.main = plan.main
    this.state.agentModels = plan.agents
    this.emit()
  }

  /* ------------------------------------------------------------- heartbeat */

  /** One heartbeat: re-plan, apply, and judge the clocks. */
  async beat(): Promise<void> {
    const now = Date.now()
    this.clocks.beat(now)

    // The control plane first. A halt written by the TUI — or by another
    // instance — is applied here even when the file watcher lost the race to
    // a status write, so the worst case for "stop now" is one heartbeat.
    // One read serves both: they are two views of the same file.
    const onDisk = readState()
    await this.applyIntent(onDisk)
    await this.reapOrphanedLoops(onDisk)

    // Re-evaluate on the interval, per the power/free/cheap mode contracts.
    await this.refresh(false)

    const now2 = Date.now()
    for (const sessionID of Object.keys(this.state.loops)) {
      const loop = this.state.loops[sessionID]
      // One heartbeat per owned ACTIVE loop: the lease, and the re-drive only
      // a cancelled turn owes. Stopped loops keep their history but beat
      // nothing.
      if (loop.status !== "active" || loop.owner !== this.instanceID) continue
      loop.ownerBeatAt = now2
      await this.maybeRedrive(sessionID)
      await this.maybeReseedRestarted(sessionID)
    }

    const verdicts = this.clocks.evaluate(now)
    for (const { sessionID, verdict } of verdicts) {
      if (verdict.action === "idle") {
        // A non-loop session going idle is simply untracked. A loop session
        // is *not* stopped here: idle between turns is the loop's normal
        // state, and the idle event handler (`advance`) is what decides
        // whether the work is finished. Stopping on idle would end the loop
        // on its first turn.
        if (this.loopFor(sessionID)) continue
        this.log.info(`session ${sessionID} idle: ${verdict.reason}`)
        this.untrack(sessionID)
        continue
      }

      if (verdict.action === "hang") {
        // Only a loop session we own is ours to rescue. Interrupting a
        // session nobody asked this plugin to manage is how a hang detector
        // becomes something that kills unrelated work — including the very
        // turn the user is watching.
        if (!this.ownsLoop(sessionID)) continue
        await this.handleHang(sessionID, verdict.reason)
      }
    }

    // Rotate past any model whose cooldown has expired and re-sweep; stale
    // funds marks age out the same way.
    this.expireCooldowns()
    this.expireFundsMarks()
    this.emit()
  }

  /**
   * A running session producing no progress at all. Interrupt it so the
   * in-flight request is cancelled, then rotate to a different model: a model
   * that hangs is a property of the model, so the recovery is to change it.
   *
   * Two bounds make this recovery instead of a spin. The hung model goes on
   * cooldown so the chain actually moves, and rotation only ever picks a model
   * that has not tried yet, so the chain is walked rather than cycled — it
   * runs free models first and local last, which is the whole point of
   * standing up to a run of rate limits. Interrupts are separately capped:
   * three of them with no completed turn means the *session* is wedged, and
   * no model swap will fix that.
   */
  private async handleHang(sessionID: string, reason: string): Promise<void> {
    this.log.warn(`hang detected on ${sessionID}: ${reason}`)

    // Not a stop when the session has been interrupted before (owner,
    // 2026-10-11): a wedged session is still rotated and still re-driven, and
    // the loop ends only on a halt. The count remains in the clocks so a
    // genuinely stuck session is visible — and the model rotation is what
    // actually fixes the common case of a model that never emits anything.
    const record = this.tracked.get(sessionID)
    const previous = record?.model ? modelKeyOf(record.model) : null

    // The interrupt is ours; mark it so the turn-end event it produces stands
    // down instead of advancing.
    this.hangInterrupts.set(sessionID, Date.now())
    await this.interruptTree(sessionID)
    this.clocks.clocksFor(sessionID).interrupted(Date.now())

    // The await above yields the thread, and a halt may have landed in it.
    // Re-read the loop and re-check ownership rather than rotating a loop
    // that was stopped while the interrupt was in flight.
    const current = this.loopFor(sessionID)
    if (!current || !this.ownsLoop(sessionID)) return

    if (previous) {
      this.putOnCooldown(previous, Date.now() + this.hangCooldownMs)
    }

    const outcome = await this.rotate(sessionID, "hang")
    if (outcome !== "moved" && outcome !== "not-ours") {
      // Not a stop (owner, 2026-10-11): every model in the chain has had its
      // try and none is cooling down yet (or nothing is left at all). The
      // recovery is to wait for the cooldowns to expire — `expireCooldowns`
      // re-admits models on the next beats — and re-drive. In `free` mode the
      // local fallback is still the chain's tail, so this usually does not
      // happen at all.
      this.log.warn(`no untried model left for ${sessionID}; waiting for cooldowns instead of stopping (${outcome})`)
      if (!this.redrives.has(sessionID)) this.scheduleRedrive(sessionID, this.redriveDelayMs)
      this.emit()
      return
    }
    current.rotations += 1

    // An aborted request never emits the idle event the loop is driven by, so
    // without a scheduled re-drive the loop would go silent right here. The
    // timer fires at the deadline; `maybeRedrive` stands down if a real turn
    // started in the meantime.
    this.scheduleRedrive(sessionID, this.redriveDelayMs)
    this.emit()
  }

  /**
   * Schedule the loop's next re-drive, replacing any pending one.
   *
   * The deadline stays in `redrives` (the durable record `beat()` reads), and
   * a timer wakes the engine at that deadline — the heartbeat is a 30s
   * cadence, far too slow to walk a chain of broken models. The timer is
   * unref'd so a pending re-drive never keeps the process alive. The prompt
   * owed defaults to the full mission; only the same-model retry of a
   * transient failure asks for the short nudge (see `Redrive`).
   */
  private scheduleRedrive(sessionID: string, delayMs: number, kind: RedriveKind = "mission"): void {
    this.redrives.set(sessionID, { at: Date.now() + delayMs, kind })
    this.armRedrive(sessionID, delayMs)
  }

  /** Arm the one timer that wakes this session's re-drive, replacing any old one. */
  private armRedrive(sessionID: string, delayMs: number): void {
    const existing = this.redriveTimers.get(sessionID)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.redriveTimers.delete(sessionID)
      void this.redriveNow(sessionID).catch(() => {})
    }, Math.max(delayMs, 0) + REDRIVE_TIMER_GRACE_MS)
    ;(timer as { unref?: () => void }).unref?.()
    this.redriveTimers.set(sessionID, timer)
  }

  /** Drop a scheduled re-drive, deadline and timer together. */
  private clearRedrive(sessionID: string): void {
    this.redrives.delete(sessionID)
    const timer = this.redriveTimers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      this.redriveTimers.delete(sessionID)
    }
  }

  /** Fire a due re-drive; re-arm while it still cannot be sent. */
  private async redriveNow(sessionID: string): Promise<void> {
    const pending = await this.maybeRedrive(sessionID)
    if (!pending) return
    const redrive = this.redrives.get(sessionID)
    if (!redrive) return
    // A session still finishing its turn is polled on the short tick; a
    // wake that arrived before the deadline (the grace in `armRedrive` does
    // not make that impossible — the clock can move) re-arms for the sliver
    // that is left, instead of paying the full poll for a missed millisecond.
    const remaining = redrive.at - Date.now()
    this.armRedrive(sessionID, remaining > 0 ? remaining : REDRIVE_POLL_MS)
  }

  /**
   * Re-drive one loop when its last turn was cancelled rather than completed.
   *
   * Deliberately conservative: it fires at the deadline, and only while the
   * session is genuinely idle — if anything started a turn in the meantime,
   * the normal idle path owns it and this stands down. The deadline is *kept*
   * rather than consumed in that case, so a re-drive scheduled behind a slow
   * turn is not thrown away.
   *
   * Returns whether the re-drive is still pending, so the timer can re-arm at
   * the right moment instead of leaving it to the next heartbeat.
   */
  private async maybeRedrive(sessionID: string): Promise<boolean> {
    const redrive = this.redrives.get(sessionID)
    if (!redrive) return false
    if (Date.now() < redrive.at) return true

    if (!this.ownsLoop(sessionID)) {
      this.clearRedrive(sessionID)
      return false
    }
    if (this.clocks.peek(sessionID)?.activity.running) return true
    this.redrives.delete(sessionID)

    // The mission for an interrupt, failure, compaction or restart — the
    // moments the re-drive exists for — and the short nudge only for the
    // same-model retry of a transient failure, whose request is already the
    // last thing in the transcript.
    const text = redrive.kind === "mission"
      ? (this.missionOf(sessionID) ?? CONTINUE_PROMPT)
      : CONTINUE_PROMPT

    try {
      this.log.info(`re-driving ${sessionID} after a cancelled turn`)
      await this.sendPrompt(sessionID, text)
      this.clocks.clocksFor(sessionID).start(Date.now())
      return false
    } catch (error) {
      // Not a stop (owner, 2026-10-11): a failed continue does not end the
      // loop, it reschedules one — the session may be mid-teardown or the
      // provider briefly unreachable, and the error funnel reports either.
      this.log.warn(`re-drive failed on ${sessionID}: ${msg(error)}; will try again`)
      this.redrives.set(sessionID, { at: Date.now() + this.redriveDelayMs, kind: redrive.kind })
      void this.onError({ sessionID, error, message: msg(error) }).catch(() => {})
      return true
    }
  }

  /**
   * A retry was scheduled on a loop's session: the endpoint already failed
   * once and opencode is backing off to try again.
   *
   * In the free sweep the policy is one try per endpoint, and "retrying in
   * Ns" is a sentence opencode would otherwise spend five attempts and about
   * a minute on before the failure surfaced. So the engine cuts the storm
   * short: the retry's own error is classified, the model goes on the same
   * cooldown it would have earned once the attempts were spent, the turn is
   * interrupted, and the chain rotates. The interrupted event that follows
   * stands down (the hang marker), and the scheduled re-drive restates the
   * mission on the next model.
   *
   * Paid modes let opencode's retries finish: a blip on a model you are
   * paying for usually recovers, and the paid chain is exactly where a
   * same-model second chance belongs.
   *
   * The cooldown window (`RETRY_INTERRUPT_COOLDOWN_MS`) is how long before a
   * loop session may interrupt for a retry storm again: after one cut the
   * turn is re-driven on a fresh model, so a subsequent retry is a new
   * failure, not the same storm observed twice.
   */
  async onRetryScheduled(sessionID: string, error: EventError | null): Promise<void> {
    const loop = this.loopFor(sessionID)
    if (!loop || !this.ownsLoop(sessionID)) return
    if (loop.mode !== "free") return
    const last = this.retryInterrupts.get(sessionID) ?? 0
    if (Date.now() - last < RETRY_INTERRUPT_COOLDOWN_MS) return
    this.retryInterrupts.set(sessionID, Date.now())

    const record = this.tracked.get(sessionID)
    const previous = record?.model ? modelKeyOf(record.model) : null

    const classified = classify({
      message: error?.message,
      status: error?.status,
      type: error?.type,
    })
    const action = actionFor(classified, loop.mode)
    this.log.warn(
      `model ${previous ?? "?"} is retrying after ${classified.kind}; interrupting the turn instead of burning the retries`,
    )

    // The interrupt is ours; mark it so the turn-end event it produces
    // stands down instead of advancing.
    this.hangInterrupts.set(sessionID, Date.now())
    await this.interruptTree(sessionID)
    this.clocks.clocksFor(sessionID).interrupted(Date.now())

    // The await above yields the thread, and a halt may have landed in it.
    const current = this.loopFor(sessionID)
    if (!current || !this.ownsLoop(sessionID)) return

    if (previous && action.cooldownMs > 0) {
      this.putOnCooldown(previous, cooldownDeadline(action.cooldownMs))
    }

    const outcome = await this.rotate(sessionID, `retry-after-${classified.kind}`)
    if (outcome !== "moved" && outcome !== "not-ours") {
      this.log.warn(`no untried model left for ${sessionID}; waiting for cooldowns instead of stopping (${outcome})`)
      if (!this.redrives.has(sessionID)) this.scheduleRedrive(sessionID, this.redriveDelayMs)
      this.emit()
      return
    }
    current.rotations += 1
    // The interrupted turn will not emit the idle event the loop is driven by,
    // so the re-drive owes the prompt. It fires at the failure delay — the
    // turn is already over, and walking a chain of broken models at the
    // heartbeat's cadence is what made the sweep look stuck.
    this.scheduleRedrive(sessionID, this.failureRedriveDelayMs)
    this.emit()
  }

  /**
   * Re-seed a loop session that was restarted underneath the engine.
   *
   * A session restart clears the conversation and starts fresh with whatever
   * the user typed — not the loop prompt. The loop record is keyed to the
   * session, so it survives, but nothing drives it anymore: the turn-end
   * events belong to the user's new text, and the loop would wait forever.
   * The restart is detected by the message count dropping below the last
   * count the engine saw, and the recovery is to re-inject the FULL loop
   * prompt — the same text the loop opened with — which is what "restart
   * session" is supposed to do.
   *
   * Compaction also removes messages, but it preserves the work, so a recent
   * compaction suppresses the check. An unreadable session keeps its old
   * baseline (no reseed on a read error, and no false drop later). A boot
   * window (`reseedGraceMs`) suppresses the check too: a service restart
   * resumes sessions through opencode's own SessionRestart, and a re-seed
   * racing that resume would send the loop prompt twice.
   */
  private async maybeReseedRestarted(sessionID: string): Promise<void> {
    const loop = this.loopFor(sessionID)
    if (!loop || !this.ownsLoop(sessionID)) return
    if (loop.prompt.trim().length === 0) return
    if (Date.now() - this.startedAt < this.reseedGraceMs) return
    // A running turn cannot have been restarted underneath us; the ending
    // event will flow, and the next beat's read sees the drop.
    if (this.clocks.peek(sessionID)?.activity.running) return
    const compacted = this.compactions.get(sessionID) ?? 0
    if (Date.now() - compacted < 90_000) return

    const count = await this.messageCount(sessionID)
    if (count < 0) return
    const previous = this.messageCounts.get(sessionID)
    this.messageCounts.set(sessionID, count)
    if (previous === undefined || count >= previous) return

    this.log.warn(`session ${sessionID} restarted (${previous} -> ${count} messages); re-injecting the loop prompt`)
    await this.sendPrompt(sessionID, loop.prompt)
    this.lastReinjections.set(sessionID, loop.iterations)
    loop.lastResult = "session restarted; loop prompt re-injected"
    this.emit()
  }

  /** Messages on a session, or -1 when the session cannot be read. */
  private async messageCount(sessionID: string): Promise<number> {
    try {
      const raw: unknown = await this.readMessages(sessionID)
      const list = Array.isArray(raw) ? raw : (raw as { data?: unknown } | null)?.data
      return Array.isArray(list) ? list.length : 0
    } catch {
      return -1
    }
  }

  /** Best-effort cancellation of an in-flight request. */
  private async interrupt(sessionID: string): Promise<void> {
    try {
      await (this.ctx.session as unknown as { interrupt(input: { sessionID: string }): Promise<unknown> })
        .interrupt({ sessionID })
    } catch (error) {
      this.log.warn(`interrupt failed for ${sessionID}: ${msg(error)}`)
    }
  }

  /* ------------------------------------------------------- control intents */

  /**
   * Act on a control intent newer than the last one this engine handled.
   *
   * Intents live in the state file and are merged by sequence number, so a
   * halt written by the TUI cannot be erased by a heartbeat that rewrote
   * everything else in the file — the exact lost update that made
   * `/dont-stop-halt` announce a stop that never happened.
   *
   * `halt` binds every instance: everybody stops driving. `start` binds only
   * the instance that can see the session it names, which is how a loop is
   * never adopted by a process it does not belong to.
   *
   * Returns whether an intent was applied. The caller uses this to decide
   * whether a reconcile changed anything — the file watcher's own writes must
   * not re-trigger the watcher, which is the feedback loop that rewrote the
   * state file every ~150ms while doing nothing.
   */
  async applyIntent(onDisk: PluginState = readState()): Promise<boolean> {
    const intent = onDisk.intent
    if (!intent || intent.seq <= this.appliedIntent) return false
    this.appliedIntent = intent.seq
    this.state.intent = intent

    if (intent.action === "halt") {
      if (this.loops().every((l) => l.status !== "active")) return true
      this.log.info(`halt requested (intent ${intent.seq})`)
      // A halt is a verb without an owner: it stops every loop this instance
      // drives. Per-session halting goes through the command, which names its
      // session.
      await this.stop(`halted by intent ${intent.seq}`)
    }

    if (intent.action === "mode") {
      // Mode changes ride the control plane so they survive every writer:
      // a TUI or command that changed the mode bumps a mode intent, and each
      // instance applies it to ITS memory before persisting, so no instance
      // can rewrite the file with a stale mode (the "it stays on free" bug).
      if (!intent.mode || !MODES.includes(intent.mode)) return true
      await this.applyModeIntent(intent.mode as Mode, intent.seq)
    }
    return true
  }

  /**
   * Apply a mode to this instance: the default mode plus the primary loop's
   * own mode, exactly what a `mode <name>` command means. Shared by the
   * intent path and the command path so both change the same two things.
   */
  private async applyModeIntent(mode: Mode, seq: number): Promise<void> {
    const primary = this.primaryLoop()
    if (primary && primary.mode !== mode) this.applyLoopMode(primary, mode)
    if (this.state.mode !== mode) {
      this.state.mode = mode
      if (!primary) this.resetEpisode()
    }
    this.log.info(`mode set to ${mode} by intent #${seq}`)
    await this.refresh(true)
  }

  /**
   * Halt loops whose owner instance is gone, and otherwise report the loops
   * the owner actually has.
   *
   * A loop is a conversation in another process; when that process dies the
   * file still says "active", and every later instance would otherwise treat
   * it as live work. The owner's heartbeat is the lease: miss three beats and
   * the loop is orphaned, and an orphaned loop is stopped, not inherited.
   *
   * The lease is judged from the file, not from this instance's memory of it:
   * a non-owner's copy only ages while the owner keeps writing, so deciding
   * from memory would eventually orphan a loop that is alive and beating.
   * Ownership is the one field where memory wins — if either copy says this
   * instance owns the loop, the file is behind and the function stands down.
   */
  async reapOrphanedLoops(onDisk: PluginState = readState()): Promise<void> {
    for (const [sessionID, disk] of Object.entries(onDisk.loops)) {
      if (!disk || disk.status !== "active") continue

      // Ours in either copy: this instance writes the lease, so memory is the
      // fresher copy and a lagging file must never overwrite it.
      const memory = this.state.loops[sessionID]
      if (memory?.owner === this.instanceID || disk.owner === this.instanceID) continue

      const beatAt = disk.ownerBeatAt ?? 0
      if (beatAt > 0 && Date.now() - beatAt <= this.leaseGraceMs) {
        // Someone else's live loop. Say so once — a footer that reads "active"
        // in a process doing nothing is otherwise a mystery.
        if (!this.reportedForeignLoop) {
          this.reportedForeignLoop = true
          this.log.info(
            `a loop is running on ${sessionID} under instance ${disk.owner}; this instance reports but does not drive it`,
          )
        }
        continue
      }

      this.log.warn(
        `loop on ${sessionID} is orphaned ` +
          `(owner ${disk.owner ?? "none"} last beat ${beatAt > 0 ? `${Math.round((Date.now() - beatAt) / 1000)}s` : "never"} ago)`,
      )
      await this.stop("loop orphaned: the instance running it is gone", sessionID)
    }
  }

  /**
   * Boot recovery for loops whose owner died with the server.
   *
   * `reapOrphanedLoops` halts an orphan mid-run: a loop is a conversation in
   * another process, and an owner silent for three beats is gone. Boot is
   * different. A service restart kills the owner without its teardown, and
   * the sessions themselves survive in the shared store — so the new instance
   * adopts the loop instead of halting it, because halting is what turned
   * "the server restarted" into "the loop silently ended" (the observed
   * symptom: sessions resume, nothing happens).
   *
   * Adoption is gated on the session being readable: a loop whose session is
   * gone has nothing to drive, and is halted exactly as before. The adopted
   * loop gets a re-drive, so if opencode's own resume does not start a turn
   * the loop still continues; if the resume is already running, the re-drive
   * stands down when the turn-start event arrives.
   */
  async recoverOrphanedLoops(onDisk: PluginState = readState()): Promise<void> {
    for (const [sessionID, disk] of Object.entries(onDisk.loops)) {
      if (!disk || disk.status !== "active") continue

      const memory = this.state.loops[sessionID]
      if (memory?.owner === this.instanceID || disk.owner === this.instanceID) continue

      const beatAt = disk.ownerBeatAt ?? 0
      if (beatAt > 0 && Date.now() - beatAt <= this.leaseGraceMs) {
        // A live owner elsewhere: report once, exactly as the reaper does.
        if (!this.reportedForeignLoop) {
          this.reportedForeignLoop = true
          this.log.info(
            `a loop is running on ${sessionID} under instance ${disk.owner}; this instance reports but does not drive it`,
          )
        }
        continue
      }

      const count = await this.messageCount(sessionID)
      if (count < 0) {
        this.log.warn(`loop on ${sessionID} cannot be recovered: its session is unreadable; halting it`)
        await this.stop("loop orphaned: the instance running it is gone", sessionID)
        continue
      }

      this.state.loops[sessionID] = {
        ...disk,
        owner: this.instanceID,
        ownerBeatAt: Date.now(),
        lastResult: "recovered after restart; continuing",
      }
      // Do not clobber an agent an event already attributed: track() replaces
      // the record's agent, and a boot-time default would outvote the event.
      if (!this.tracked.has(sessionID)) this.track(sessionID)
      this.messageCounts.set(sessionID, count)
      this.log.warn(`recovered loop on ${sessionID} left by instance ${disk.owner ?? "none"}; adopting it`)
      this.scheduleRedrive(sessionID, this.redriveDelayMs)
      this.emit()
    }
  }

  /**
   * Whether two different paid providers are both out of money, right now.
   *
   * Marks older than the window are stale — an account resettled is a mark
   * that no longer means anything — and are dropped in the same pass.
   */
  private fundsShortfall(): boolean {
    const now = Date.now()
    const window = FUNDS_PROVIDER_WINDOW_MS
    let distinct = 0
    for (const [provider, at] of Object.entries(this.state.fundsProviders)) {
      if (now - at > window) {
        delete this.state.fundsProviders[provider]
        continue
      }
      distinct += 1
    }
    return distinct >= 2
  }

  /** Drop insufficient-funds marks that have outlived their window. */
  private expireFundsMarks(): void {
    const now = Date.now()
    const window = FUNDS_PROVIDER_WINDOW_MS
    for (const [provider, at] of Object.entries(this.state.fundsProviders)) {
      if (now - at > window) delete this.state.fundsProviders[provider]
    }
  }

  /* ---------------------------------------------------------------- errors */

  /**
   * Handle a failed request. This is the single recovery funnel: the retry
   * hook and any caught error both land here.
   */
  async onError(input: {
    sessionID?: string
    agent?: string
    message?: string
    status?: number
    type?: string
    error?: unknown
  }): Promise<ErrorAction> {
    const classified = classify(input)
    const action = actionFor(classified, this.state.mode)

    const where = input.sessionID ? ` on ${input.sessionID}` : ""
    const line = `${classified.kind}${where}: ${classified.message || describe(classified)}`
    // An interrupted request is the recovery working, not a failure; logging
    // it as one buries the real errors in noise.
    if (classified.kind === "interrupted") this.log.quiet("info", line)
    else this.log.warn(line)

    const ownsThis = input.sessionID !== undefined && this.ownsLoop(input.sessionID)
    const record = input.sessionID ? this.tracked.get(input.sessionID) : undefined
    const key = record?.model ? modelKeyOf(record.model) : null
    const loop = ownsThis && input.sessionID ? this.loopFor(input.sessionID) : undefined

    // The loop's turn just died: however the session ends up idling, that turn
    // must not be counted as completed work.
    if (ownsThis && input.sessionID) this.failedTurns.add(input.sessionID)

    // A retryable failure on the loop's own model is worth one more attempt
    // on that same model before we spend a rotation: a dropped connection or
    // an unclassified error usually clears in seconds, and rotating loses the
    // turn anyway. Everything else — a rate limit, a capability miss, an
    // over-full context, an account with no money — rotates now, because it
    // fails the same way twice.
    const failures = key ? (this.retries[key] ?? 0) : 0
    const willRetry = action.retry && ownsThis && key !== null && failures === 0

    // A retried model must not be cooled down: the next attempt is aimed
    // straight at it, and the cooldown would only take it out of the chain the
    // retry is hoping to succeed on.
    if (key && !willRetry && action.cooldownMs > 0) {
      this.putOnCooldown(key, cooldownDeadline(action.cooldownMs))
    }

    if (action.restrict) {
      const agent = input.agent ?? "general"
      this.restrictions[agent] = { ...(this.restrictions[agent] ?? {}), ...restrictionRequirements(action.restrict) }
      this.log.info(`restricted pool for ${agent}: ${action.restrict}`)
    }

    // An insufficient-funds failure is marked per PROVIDER (owner, 2026-10-12):
    // the account may still be able to pay one of its paid providers, and a
    // single provider being out of money is a rotation, not a mode change.
    // The mode moves only when two different providers are both out.
    if (classified.kind === "funds" && record?.model) {
      this.state.fundsProviders[record.model.providerID] = Date.now()
    }

    if (action.degrade) {
      // Only `funds` asks to degrade, and even it must clear the two-provider
      // bar. A funds failure from the loop's own model with no other provider
      // marked fresh keeps the mode and rotates instead.
      if (classified.kind !== "funds" || this.fundsShortfall()) {
        if (ownsThis && input.sessionID) {
          await this.degradeMode(input.sessionID, action.reason)
        } else {
          this.log.info(`funds failure outside the loop; no mode moves (${action.reason})`)
        }
      } else {
        const provider = record?.model?.providerID ?? "unknown"
        this.log.info(`funds failure on ${provider} only; not degrading until a second provider is out of money`)
      }
    }

    if (this.consecutive(classified)) {
      // Reported, not stopped (owner, 2026-10-11): the loop survives error
      // streaks. The counter sits on the loop, so a degenerate provider
      // run is visible before it becomes a wallpaper.
      if (loop) loop.consecutiveErrors += 1
    } else if (loop) {
      loop.consecutiveErrors = 0
    }

    // Stale provider state (an expired reasoning item the endpoint no longer
    // holds) is a fact about the transcript, not the model: no cooldown and
    // no rotation by default. Compaction replaces the transcript carrying the
    // dangling reference, and the re-drive restates the mission against the
    // compacted context. When compaction is already rate-limited — it did
    // not clear the state — the loop pays a rotation instead of spinning on
    // the same request.
    if (action.compact && ownsThis && input.sessionID) {
      const compacted = await this.compactSession(input.sessionID)
      if (compacted) {
        // The compaction lands at the next step boundary, so the continue
        // prompt is the thing that triggers it — it goes out promptly, not on
        // the hang-settle delay.
        this.scheduleRedrive(input.sessionID, this.failureRedriveDelayMs)
        this.emit()
        return action
      }
      this.log.warn(`compaction unavailable for ${input.sessionID}; rotating past the stale state`)
      const outcome = await this.rotate(input.sessionID, classified.kind)
      if (outcome !== "moved" && outcome !== "not-ours") {
        this.log.warn(`no untried model left for ${input.sessionID}; waiting for cooldowns instead of stopping (${outcome})`)
        if (!this.redrives.has(input.sessionID)) this.scheduleRedrive(input.sessionID, this.redriveDelayMs)
      }
      this.emit()
      return action
    }

    if (willRetry && key) {
      this.retries[key] = failures + 1
      this.log.info(`retrying ${key} once after ${classified.kind} before rotating`)
      // Nothing has changed on the session, so nothing will prompt it: the
      // re-drive is what turns "retry" into an actual second attempt. The
      // transcript is intact, so this is the one re-drive that keeps the
      // short nudge instead of restating the mission.
      if (input.sessionID) this.scheduleRedrive(input.sessionID, this.failureRedriveDelayMs, "nudge")
    } else if (action.resweep && input.sessionID && ownsThis) {
      const outcome = await this.rotate(input.sessionID, classified.kind)
      // Not a stop when the chain has nothing left (owner, 2026-10-11): the
      // loop waits for cooldowns to expire instead. `"not-ours"` is a rotation
      // that was never ours to make, and quietly does nothing.
      if (outcome !== "moved" && outcome !== "not-ours") {
        this.log.warn(`no untried model left for ${input.sessionID}; waiting for cooldowns instead of stopping (${outcome})`)
        if (!this.redrives.has(input.sessionID)) this.scheduleRedrive(input.sessionID, this.redriveDelayMs)
        this.emit()
        return action
      }
      // The rotation landed on a fresh model and the failed turn owes a
      // prompt. Some failures reach here without the execution-failed ending
      // that would advance the loop (`session.error` is not a turn-end event),
      // so the re-drive is scheduled now — at the failure delay, not the
      // heartbeat's cadence — and walks the chain immediately when the new
      // model fails too.
      if (outcome === "moved") this.scheduleRedrive(input.sessionID, this.failureRedriveDelayMs)
    }

    this.emit()
    return action
  }

  private consecutive(error: ClassifiedError): boolean {
    return error.kind === "other" || error.kind === "auth" || error.kind === "notfound" || error.kind === "state"
  }

  private expireCooldowns(): void {
    const now = Date.now()
    let changed = false
    for (const [key, until] of Object.entries(this.state.cooldowns)) {
      if (until <= now) {
        delete this.state.cooldowns[key]
        changed = true
        if (this.catalogue) {
          markAvailable(this.catalogue, key)
          // The catalogue row carries its own cooldown clock; without this
          // the row would stay excluded by `meets()` long after the sentence
          // was served — the hang-path cooldown used to leak past its expiry
          // and lock a model out of every chain forever.
          clearCooldown(this.catalogue, key)
        }
        // The cooldown was the sentence; it is served. Keeping the model in
        // the tried set would mean a free model that rate-limited once could
        // never be picked again this episode, so the loop would sit on the
        // local fallback while the model it actually wanted was available.
        this.tried.delete(key)
      }
    }
    if (changed) this.emit()
  }

  /* ------------------------------------------------------------- rotation */

  /**
   * Move a session to the next model in its mode's chain that has not yet had
   * a try since the last completed turn.
   *
   * The point is one try per model rather than cycling. The old form advanced a
   * cursor and took whatever it landed on, so with three usable models a stuck
   * task rotated through the same three forever — the exact loop this plugin
   * exists to break. Now the models already tried are skipped, and a chain
   * with nothing left to offer says so, which is the caller's signal to stop.
   *
   * The outcome is a string rather than a boolean because two of the four ways
   * to move nothing mean opposite things: `"not-ours"` is a caller bug (or an
   * error on a session the loop does not own) and must be ignored, while
   * `"exhausted"` and `"unavailable"` are the loop running out of models and
   * are the caller's signal to stop it.
   */
  async rotate(sessionID: string, cause: string): Promise<RotationOutcome> {
    // Only the loop's owner moves a session's model. Rotation from an error on
    // some other session — or from another instance watching the same file —
    // is this plugin reaching into work it was not asked to manage.
    const loop = this.loopFor(sessionID)
    if (!loop || !this.ownsLoop(sessionID)) return "not-ours"

    const record = this.tracked.get(sessionID)
    if (!record) return "not-ours"
    const agent = record.agent

    if (!this.catalogue) return "unavailable"
    // The session's current usage is read before ranking: it is both the
    // context a candidate must hold and the price tier cheap mode ranks at.
    const used = await this.contextUsed(sessionID)
    const ranked = rankForMode(this.catalogue, loop.mode, this.taskFor(agent), this.hardware, used)
    if (ranked.length === 0) {
      this.log.warn(`no model left in the ${loop.mode} chain for ${agent}`)
      return "unavailable"
    }

    // The model we are leaving has had its try. The pick is the best-ranked
    // model that has not, which is a plain rank-order walk from the top rather
    // than a cursor: rank order *is* the preference, and a cursor would walk
    // past a free model that just came off cooldown before reaching it, since
    // the local tail sits below it in the chain. One try per model is what
    // bounds the walk — a chain of N gives N turns and then stops, so there is
    // no rotation cap on top of it.
    if (record.model) this.tried.add(modelKeyOf(record.model))

    // A model that cannot hold the conversation it is about to receive is not
    // a candidate: a 200k session dropped onto a 64k local window comes back
    // truncated every turn, which is how a rotation looks like a hang. The
    // session's current usage is the bar, and candidates are walked twice —
    // first those that can hold it, and if none can, the session is compacted
    // (the transcript is state; the work is on disk) before the chain is
    // walked again.
    let pick: CatalogueModel | null = null
    for (const candidate of ranked) {
      if (this.tried.has(`${candidate.providerID}/${candidate.id}`)) continue
      if (used > 0 && !(await this.canHoldContext(candidate, used))) continue
      pick = candidate
      break
    }
    if (!pick && used > 0) {
      await this.compactSession(sessionID)
      for (const candidate of ranked) {
        if (this.tried.has(`${candidate.providerID}/${candidate.id}`)) continue
        pick = candidate
        break
      }
    }
    if (!pick) {
      loop.lastResult =
        `every model in the ${loop.mode} chain for ${agent} has had its try (${ranked.length} models)`
      this.log.warn(loop.lastResult)
      return "exhausted"
    }

    record.model = slotFrom(pick)
    this.tried.add(modelKeyOf(pick))
    loop.lastResult = `rotated ${agent} to ${pick.providerID}/${pick.id} (${cause})`
    this.log.info(loop.lastResult)

    // Await the switch: the caller's re-drive prompts the session moments
    // later, and a prompt that races the pin runs on the model we just left —
    // the rotation would look like it did nothing.
    await applySessionModels(
      this.ctx as unknown as ApplyContext,
      [{ sessionID, model: record.model }],
      this.log,
    )
    return "moved"
  }

  /**
   * Cheap mode's pick for a session whose next request carries `used` tokens.
   *
   * The plan's cheap ranking is priced at the base rate, which is right for a
   * fresh session and wrong for a long one: qwen3.7-flash is the cheapest paid
   * row up to 32k and third-most-expensive past 256k. So a session being
   * (re)pinned in cheap mode is ranked at its actual context and the first
   * candidate that can hold it wins. Null when nothing qualifies — the caller
   * then keeps the session where it is.
   */
  private async cheapPickForContext(agent: string, used: number): Promise<CatalogueModel | null> {
    if (!this.catalogue || used <= 0) return null
    const ranked = rankForMode(this.catalogue, "cheap", this.taskFor(agent), this.hardware, used)
    for (const candidate of ranked) {
      if (await this.canHoldContext(candidate, used)) return candidate
    }
    return null
  }

  /**
   * Whether a candidate can carry the session's current context.
   *
   * Remote rows are judged by their advertised window. Local rows are judged
   * by what the daemon actually serves — `OLLAMA_CONTEXT_LENGTH` can be a
   * fraction of the native window and truncates the prompt to fit, which is
   * how a session on a "200k" local model gets every turn cut off. When the
   * model is loaded the served figure is reported and wins; when it is not,
   * the daemon says nothing, so the served window is assumed to be the
   * observed local cap (`OLLAMA_CONTEXT_LENGTH=64000` here) rather than the
   * native figure — a session past that cap on an unloaded local model does
   * not get the switch, and the compact-first fallback in `rotate` runs.
   */
  private async canHoldContext(candidate: CatalogueModel, used: number): Promise<boolean> {
    if (used <= 0) return true
    if (!candidate.local) return candidate.context >= used
    const served = await ollamaServedContext(candidate.id)
    if (served > 0) return effectiveContext(candidate.context, served) >= used
    return LOCAL_WINDOW_UNKNOWN_GUARD >= used
  }

  /** The catalogue row a plan slot names, or null when unknown. */
  private catalogueRowFor(slot: ModelSlot): CatalogueModel | null {
    if (!this.catalogue) return null
    return this.catalogue.byKey.get(slotKey(slot.providerID, slot.id, slot.variant)) ?? null
  }

  /**
   * Request compaction of a loop session's transcript.
   *
   * Two callers, one action: a session no candidate model can hold, and a
   * session whose transcript carries provider state the endpoint no longer
   * honors (a stale reasoning item). Best-effort and rate-limited per session:
   * the server admits the request and compacts at the next step boundary — the
   * mission restatement that follows — so the next turn runs on a transcript
   * that fits, or that no longer references the expired state.
   */
  private async compactSession(sessionID: string): Promise<boolean> {
    const last = this.compactionRequests.get(sessionID) ?? 0
    if (Date.now() - last < COMPACTION_REQUEST_COOLDOWN_MS) return false
    this.compactionRequests.set(sessionID, Date.now())
    try {
      const api = this.ctx as unknown as {
        session?: { compact?(input: { sessionID: string }): Promise<unknown> }
      }
      await api.session?.compact?.({ sessionID })
      this.log.info(`compacting ${sessionID}: transcript down, work untouched`)
      return true
    } catch (error) {
      this.log.warn(`compaction failed on ${sessionID}: ${msg(error)}`)
      return false
    }
  }

  /* ----------------------------------------------------------- mode changes */

  /**
   * Switch a loop's mode — or the default mode when no session is named.
   *
   * Per-session (owner, 2026-10-12): a mode belongs to the loop it runs in,
   * so `setMode(mode, sessionID)` changes THAT session's loop and nothing
   * else. Without a session, it changes the DEFAULT mode for new loops and,
   * as a convenience for the single-loop case, the primary active loop too.
   */
  async setMode(mode: Mode, sessionID?: string): Promise<void> {
    if (sessionID) {
      // One session's loop only: the other loops keep their own modes.
      const loop = this.loopFor(sessionID)
      if (!loop) {
        this.log.warn(`no loop on session ${sessionID}; mode unchanged`)
        return
      }
      if (loop.mode !== mode) this.applyLoopMode(loop, mode)
      await this.refresh(true)
      return
    }
    // No session named: the default mode changes, and — the single-loop
    // convenience — the primary active loop follows it. Two sessions running
    // loops of their own are untouched by this call. The change is announced
    // on the control plane: a mode intent survives other instances' status
    // writes — which is what turns "mode cheap" from a change that snapped
    // back to free into one that sticks.
    const intent = bumpIntent(this.state, "mode", mode)
    this.appliedIntent = intent.seq
    await this.applyModeIntent(mode, intent.seq)
  }

  /** Put one loop on a mode: reset its per-mode state and re-plan. */
  private applyLoopMode(loop: LoopState, mode: Mode): void {
    loop.mode = mode
    loop.degraded = false
    loop.preferredMode = null
    loop.consecutiveErrors = 0
    // A permanent free-quota exclusion belongs to the free sweep, and only to
    // it: in `cheap` the same model is a paid row and is selectable again. So
    // leaving free mode lifts every permanent cooldown; ordinary timed
    // cooldowns are untouched.
    if (mode !== "free") this.liftPermanentCooldowns()
    // A new chain is a new bet, so the episode's try budget starts over.
    this.resetEpisode()
    this.log.info(`mode set to ${mode}${loop.sessionID ? ` on ${loop.sessionID}` : ""}`)
  }

  /** Clear the cooldowns a spent free quota earned. */
  private liftPermanentCooldowns(): void {
    const keys = Object.keys(this.state.cooldowns).filter(
      // Exact match, deliberately: only the free-sweep sentinel is lifted. A
      // deprecated model's own permanent sentinel (DEPRECATED_COOLDOWN_MS =
      // PERMANENT_COOLDOWN_MS - 1) is a fact about the model, never about the
      // mode, so leaving the sweep must not bring it back.
      (key) => this.state.cooldowns[key] === PERMANENT_COOLDOWN_MS,
    )
    if (keys.length === 0) return
    for (const key of keys) delete this.state.cooldowns[key]
    if (this.catalogue) for (const key of keys) clearCooldown(this.catalogue, key)
    this.log.info(`mode left the free sweep; lifted ${keys.length} permanent quota exclusions`)
  }

  /** Drop one loop to a cheaper mode, recording where it degraded from. */
  private async degradeMode(sessionID: string, reason: string): Promise<void> {
    const loop = this.loopFor(sessionID)
    if (!loop) return
    const chain = degradeChainOf(loop.mode)
    if (chain.length <= 1) {
      this.log.warn(`cannot degrade below ${loop.mode}: ${reason}`)
      return
    }
    const next = chain[1]
    if (!loop.degraded) loop.preferredMode = loop.mode
    loop.degraded = true
    this.log.warn(`degrading ${loop.mode} -> ${next} on ${sessionID}: ${reason}`)
    loop.mode = next
    // A cheaper chain is a different set of models, so the episode's try budget
    // starts over rather than inheriting the previous chain's verdicts.
    this.resetEpisode()
    await this.refresh(true)
  }

  /* -------------------------------------------------------- loop the driver */

  /**
   * Advance the loop after its session goes idle.
   *
   * This is the piece that makes the loop a loop. When the session finishes a
   * turn it goes idle; rather than treating that as the end, the loop decides:
   *
   * 1. Count the completed iteration and the session's turn.
   * 2. Compact when the session step budget is exceeded, so a long
   *    conversation is trimmed rather than abandoned.
   * 3. **Re-plan** — re-rank the catalogue, sweep for a model that has become
   *    available or a better one for the task, and switch the session if the
   *    answer changed. This is the "continually evaluate on each turn"
   *    contract, and it runs before the prompt so the next turn is already on
   *    the current best model.
   * 4. Send the next prompt. A turn with tool work gets a short nudge; the
   *    full loop prompt is restated right after a compaction, on the
   *    `reinjectEvery` cadence, and when the turn that just ended used no
   *    tool — the mission drifts out of attention as the conversation grows,
   *    and a model that only talks about the work is where that shows. There is no completion protocol: the model is never
   *    asked to declare the work done, and nothing but the owner halts the
   *    loop.
   *
   * `advancing` guards the re-entrancy: an idle event can arrive while a prompt
   * is in flight, and two prompts for one turn would double the work and
   * desynchronise the counters.
   */
  async advance(sessionID: string): Promise<void> {
    if (this.advancing.has(sessionID)) return
    if (!this.ownsLoop(sessionID)) return
    const loop = this.loopFor(sessionID)!

    this.advancing.add(sessionID)
    // The turn that ended is over; a new one is marked by sendPrompt.
    this.state.loops[sessionID]!.turnStartedAt = null
    // A real turn completed, so any pending re-drive of a cancelled one is
    // stale: this idle event is the driver now.
    this.clearRedrive(sessionID)
    try {
      loop.iterations += 1
      loop.sessionIterations += 1
      // Finished work is the evidence that the model was not the problem, so
      // the episode's try budget starts over. A turn that merely *errored* into
      // idleness does not count as finished — otherwise a failing model would
      // clear its own failure count every time it gave up, and earn an
      // unlimited number of retries.
      if (!this.failedTurns.has(sessionID)) this.resetEpisode()
      const iteration = loop.iterations
      loop.lastResult = `iteration ${iteration} complete`
      this.emit()

      if (iteration >= this.maxIterations) {
        // Not a stop (owner, 2026-10-11): the loop runs until its owner
        // halts it. The iteration counter is still reported so a runaway is
        // visible in the footer.
        this.log.warn(`iteration ${iteration} reached the ${this.maxIterations} budget; continuing`)
      }

      if (loop.consecutiveErrors >= 5) {
        // Not a stop (owner, 2026-10-11): the loop survives its own error
        // streaks. The count is reported so the condition is visible.
        this.log.warn(`${loop.consecutiveErrors} consecutive errors and continuing`)
      }

      // Compact when the step budget is exceeded — keep one session,
      // trim context, rather than rotating to a new session.
      let compactedNow = false
      if (loop.sessionIterations >= this.sessionSteps) {
        compactedNow = await this.compactSession(sessionID)
        loop.sessionIterations = 0
        this.log.info(`compacted ${sessionID}: step budget exceeded, reset sessionIterations`)
      }

      // Re-plan before continuing, so the next turn runs on the current best
      // model rather than whatever happened to be selected earlier.
      await this.refresh(false)

      // The next prompt. Compaction summarizes the opening prompt away and
      // attention to it fades as the conversation grows, so the full mission
      // is restated after a compaction, when the cadence is due, and when the
      // turn that just ended used no tool at all — the model talking about
      // the task instead of doing it is the stagnant state the restatement
      // exists for. The cadence counts from the last restatement, so an
      // earlier one (here or on a re-drive) moves it rather than leaving a
      // second one a turn later. Between restatements the short nudge is
      // enough while the context still holds the task.
      const stagnant = !this.turnToolUse.has(sessionID)
      const lastRestated = this.lastReinjections.get(sessionID) ?? 0
      const overdue = this.reinjectEvery > 0 && iteration - lastRestated >= this.reinjectEvery
      let nextPrompt = CONTINUE_PROMPT
      if (compactedNow || stagnant || overdue) {
        nextPrompt = this.missionOf(sessionID) ?? CONTINUE_PROMPT
      }
      await this.sendPrompt(sessionID, nextPrompt)
      this.clocks.clocksFor(sessionID).start(Date.now())
      loop.lastResult = stagnant
        ? `iteration ${iteration} done with no tool activity; restating the mission`
        : `iteration ${iteration} done; continuing`
      this.log.info(`loop iteration ${iteration} complete; continuing`)
      this.emit()
    } catch (error) {
      this.log.error(`advance failed on ${sessionID}: ${msg(error)}`)
      loop.consecutiveErrors += 1
      // The prompt never landed, so nothing else will drive the loop: without
      // a re-drive it would sit idle until the owner noticed.
      this.scheduleRedrive(sessionID, this.failureRedriveDelayMs)
      this.emit()
    } finally {
      this.advancing.delete(sessionID)
    }
  }

  /** Send one prompt to a session. */
  async sendPrompt(sessionID: string, text: string): Promise<void> {
    // A prompt starts a turn, so whatever happened to the last one is settled.
    // This is what lets `advance` tell "the turn finished" from "the turn
    // errored into idleness". Arming the turn here also guards against the
    // pair of turn-end events an ending produces: the first one advances, the
    // second is a duplicate that must not.
    this.failedTurns.delete(sessionID)
    // The new turn starts with no tool use recorded; `observe` sets the flag
    // when one arrives, so the turn-end read describes exactly this turn.
    this.turnToolUse.delete(sessionID)
    this.armedSessions.add(sessionID)
    const loop = this.loopFor(sessionID)
    if (loop) {
      // A turn is in flight from here until its first turn-end event. The
      // status surfaces this as "working", so a slow turn — first token on a
      // local model, a long generation — does not read as a hung loop.
      loop.turnStartedAt = Date.now()
      this.emit()
    }
    const session = this.ctx as unknown as {
      session: { prompt(input: { sessionID: string; text: string }): Promise<unknown> }
    }
    await session.session.prompt({ sessionID, text })
  }

  /**
   * The full mission, restated, with the reinjection countdown wound.
   *
   * Every path that restates the mission comes through here — the cadence and
   * stagnation paths in `advance`, and every re-drive that carries the
   * mission — so the `reinjectEvery` countdown always measures turns since
   * the last restatement. Null when the loop has no prompt to restate, so
   * callers fall back to the short nudge instead of sending an empty message.
   */
  private missionOf(sessionID: string): string | null {
    const loop = this.loopFor(sessionID)
    if (!loop || loop.prompt.trim().length === 0) return null
    this.lastReinjections.set(sessionID, loop.iterations)
    return missionText(loop.prompt)
  }

  /**
   * Start a fresh episode: forget which models have had their try and how many
   * times each has failed.
   *
   * Called when a turn completes — progress is what earns the models another
   * chance — and when the chain itself changes, since a new chain is a new bet.
   */
  private resetEpisode(): void {
    this.tried.clear()
    this.retries = {}
    for (const loop of this.loops()) loop.rotations = 0
  }

  /**
   * Why this session should rotate now, or null.
   *
   * The session step budget and context pressure are the triggers; there is no
   * boundary signal any more (the loop asks the model for no tokens), so this
   * is only consulted when a rotation path is restored.
   */
  private async rotationReason(sessionID: string, loop: LoopState): Promise<string | null> {
    if (loop.sessionIterations >= this.sessionSteps) return "session budget"
    const limit = await this.contextLimitFor(sessionID)
    if (limit <= 0) return null
    const used = await this.contextUsed(sessionID)
    if (used <= 0 || !shouldRotate(used, limit, this.rotationThreshold)) return null
    return `context ${Math.round((used / limit) * 100)}%`
  }

  /**
 * The loop's title: the first substantial line of its prompt.
 *
 * The task label is the first substantial line of the loop prompt, so a loop
 * whose prompt names its work ("Task 1 changing the widget") titles its
 * session "Task 1 changing the widget". A leading mode line
 * ("mode free") is skipped — it is policy, not task.
 */
private rotationTitle(loop: LoopState): string {
  const lines = loop.prompt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const task = lines.find((l) => !/^mode\s+\w+$/i.test(l)) ?? "loop"
  return task.slice(0, 70)
}

/** The seed for a rotated session: the loop's own prompt, framed as a fresh start. */
  private rotationSeed(prompt: string): string {
    return (
      `A previous session finished a stretch of work and was retired to keep context fresh. ` +
      `Nothing was carried over: the repository is the state. Re-establish where the work stands ` +
      `from the plans and task files, reading only as much as you need — the retired session ` +
      `filled its window, so do not re-read large material wholesale and leave room in this one ` +
      `for the work itself.\n\n` +
      `Original task: ${prompt.trim() || "(none recorded)"}`
    )
  }

  /**
   * Start the loop's successor session and move the loop record to it.
   *
   * The successor is empty — no history, no tool calls, no summary — because
   * the work is on disk and the seed says so. A deferral is remembered and
   * retried on the next turn end.
   */

  /** The context window of the session's current model, or 0 when unknown. */
  private async contextLimitFor(sessionID: string): Promise<number> {
    const slot = this.tracked.get(sessionID)?.model
    if (!slot || !this.catalogue) return 0
    const row = this.catalogue.byKey.get(`${slot.providerID}/${slot.id}`)
      ?? this.catalogue.byKey.get(`${slot.providerID}/${slot.id}#${slot.variant ?? ""}`)
    if (!row) return 0
    // A local model's catalogue figure is the architecture's native window;
    // the daemon may serve a fraction of it (OLLAMA_CONTEXT_LENGTH) and
    // truncates the prompt to what it serves. Measuring against the native
    // figure is how a session sails past the real limit and every turn comes
    // back cut off, so the served window wins when the daemon reports one.
    if (!row.local) return row.context
    return effectiveContext(row.context, await ollamaServedContext(slot.id))
  }

  /** Tokens of context the session has consumed. */
  private async contextUsed(sessionID: string): Promise<number> {
    try {
      const messages = await this.readMessages(sessionID)
      return measureContext(messages)
    } catch {
      return 0
    }
  }

  private async readMessages(sessionID: string): Promise<unknown> {
    const api = this.ctx as unknown as {
      session: { context(input: { sessionID: string }): Promise<unknown> }
    }
    return api.session.context({ sessionID })
  }

  /* -------------------------------------------------------- loop lifecycle */

  async start(sessionID: string, prompt: string, mode?: Mode): Promise<void> {
    const existing = this.state.loops[sessionID]
    if (existing?.status === "active" && existing.owner !== this.instanceID) {
      this.log.warn(
        `a loop is already running on ${sessionID} under instance ${existing.owner ?? "none"}; ` +
          `stop it before starting another`,
      )
      return
    }
    // If a loop is stopped, reset it completely so we start fresh.
    if (existing?.status === "stopped") {
      this.log.info(`resetting stopped loop ${sessionID} before starting fresh`)
    }

    this.track(sessionID)
    this.state.loops[sessionID] = {
      status: "active",
      sessionID,
      sessionNumber: 1,
      prompt,
      // A start is a fresh run: the iteration counter belongs to the run,
      // not to the session's earlier loops. The mode comes from the caller,
      // else the session's previous mode, else the default.
      iterations: 0,
      sessionIterations: 0,
      startedAt: Date.now(),
      lastResult: "loop started",
      owner: this.instanceID,
      ownerBeatAt: Date.now(),
      rotations: 0,
      mode: mode ?? existing?.mode ?? this.state.mode,
      degraded: false,
      preferredMode: null,
      consecutiveErrors: 0,
      turnStartedAt: null,
    }
    const loop = this.state.loops[sessionID]
    this.failedTurns.delete(sessionID)
    this.clearRedrive(sessionID)
    this.lastReinjections.delete(sessionID)
    this.resetEpisode()
    // Announce ownership in the control plane, so every other instance reads
    // this loop as somebody else's and leaves it alone.
    this.appliedIntent = bumpIntent(this.state, "start").seq
    this.clocks.clocksFor(sessionID).start(Date.now())
    this.log.info(`loop started on ${sessionID} (${loop.mode}): ${prompt.slice(0, 80)}`)

    // Plan first so the opening turn already runs on the right model.
    await this.refresh(true)

    // Then send the opening prompt: the mission itself, with nothing appended.
    // There is no protocol to teach — the loop just keeps prompting.
    try {
      await this.sendPrompt(sessionID, prompt)
      this.clocks.clocksFor(sessionID).start(Date.now())
      // The opening turn's message count is the restart detector's baseline:
      // a session that later drops below it was restarted, not edited.
      const count = await this.messageCount(sessionID)
      if (count >= 0) this.messageCounts.set(sessionID, count)
    } catch (error) {
      this.log.error(`could not send the opening prompt: ${msg(error)}`)
      await this.stop(`failed to send the opening prompt: ${msg(error)}`, sessionID)
      return
    }
    this.emit()
  }

  /**
   * Disarm loops and clean up after them, whether or not they were running.
   *
   * Without a session id, EVERY loop this instance drives is halted — a halt
   * is a verb without an owner (a teardown, a palette stop, an intent). With
   * one, only that session's loop is.
   *
   * The cleanup is the point. The old form returned early when the status was
   * already "stopped", which silently dropped the two things that actually end
   * the *behaviour*: the in-flight request is cancelled, and the session's
   * clocks are dropped so the hang detector stops judging a turn nobody is
   * waiting on. Halting appeared to work — the status flipped — while the
   * interrupt-and-rotate cycle it was meant to end kept firing.
   *
   * A loop the FILE has already settled is not re-settled here: opencode loads
   * a plugin instance per session and unloads it on every session switch, so
   * a teardown frequently finds a loop that another instance's teardown (or a
   * halt intent) already stopped. Re-writing it with our own reason is how
   * one unload became an endless "plugin unloaded" toast — every stale
   * instance clobbered `lastResult` anew. The on-disk record is adopted into
   * memory instead, the cleanup still runs, and the follow-up persist writes
   * nothing new.
   */
  async stop(reason: string, sessionID?: string, onDiskArg?: PluginState): Promise<void> {
    const onDiskLoops = (onDiskArg ?? readState()).loops
    const targets = sessionID ? (this.state.loops[sessionID] ? [sessionID] : []) : Object.keys(this.state.loops)
    let acted = false
    let unsettled = false
    for (const sid of targets) {
      const loop = this.state.loops[sid]
      // Nothing is running: an idle stop — a plugin teardown, a second halt
      // for a loop that already ended, a duplicate command — must not
      // overwrite the last real result. `loop.lastResult` is what the terminal
      // announces, and one teardown writing "plugin unloaded" over it is how a
      // single unload became an endless toast.
      if (loop.status !== "active") continue
      acted = true

      const settled = onDiskLoops[sid]?.status === "stopped"
      if (settled) {
        // The file already describes this halt — whoever got there first kept
        // the report the terminal already announced. Adopt it wholesale so
        // this teardown's persist is a no-op instead of a re-toast.
        this.state.loops[sid] = { ...onDiskLoops[sid]! }
      } else {
        unsettled = true
        loop.status = "stopped"
        loop.lastResult = reason
        loop.owner = null
        loop.ownerBeatAt = 0
        loop.rotations = 0
        loop.turnStartedAt = null
      }
      this.clearRedrive(sid)
      // The loop keeps its sessionID so a later `start` finds its home; the
      // owner is what says nobody drives it right now.
      this.armedSessions.delete(sid)
      this.hangInterrupts.delete(sid)
      this.turnToolUse.delete(sid)
      this.lastReinjections.delete(sid)

      // The halt applies to the whole tree, not just the root: subagents of
      // the loop's session were spawned by it, and a loop that is over must
      // not leave a fan-out writing into abandoned work. Only live members
      // are interrupted; the rest only lose their clocks.
      await this.interruptTree(sid)
      this.clocks.forget(sid)
      const tree = await this.sessionTree(sid)
      for (const id of tree) {
        if (id === sid) continue
        this.untrack(id)
      }
      // The loop session itself is kept tracked: a dropped session would make
      // the next `start` fail with "no session to run the loop on" until the
      // user happened to talk to it again.
    }
    // The episode's try budget belongs to a loop that is over.
    if (acted) this.resetEpisode()

    if (unsettled) {
      // Announce the halt on the control plane: bumping the sequence is what
      // lets this survive a status write that raced it, and tells every other
      // instance the loop is over rather than merely idle.
      this.appliedIntent = bumpIntent(this.state, "halt").seq
      this.log.info(`loop${targets.length > 1 ? "s" : ""} stopped: ${reason}`)
      this.emit()
    }
  }

  /** Persist and notify. */
  private emit(): void {
    this.options.onStateChange?.(this.state)
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Whether an agent kind wants a vision-capable model by default.
 *
 * Architects and explorers read diagrams, screenshots and rendered output, so
 * they ask for vision and the mode must find a vision model. Build and review
 * work on text, and asking for vision there would exclude strong text-only
 * models for no benefit.
 */
function visionWanted(kind: AgentKind): boolean {
  return kind === "architect" || kind === "explore"
}

/**
 * The `provider/model` identity used for cooldowns, tried-sets and retry
 * counts. One function because the same string is built in four places and a
 * typo in any of them silently splits one model's bookkeeping into two.
 */
function modelKeyOf(model: { providerID: string; id: string }): string {
  return `${model.providerID}/${model.id}`
}

function agentKind(agent: string): AgentKind {
  const lower = agent.toLowerCase()
  if (/architect|plan/.test(lower)) return "architect"
  if (/build|coder|implement/.test(lower)) return "build"
  if (/review|audit|verify/.test(lower)) return "review"
  if (/explore|search|research/.test(lower)) return "explore"
  if (/general|default|main/.test(lower)) return "general"
  return "other"
}

/**
 * The mode degradation chain. Mirrors `lib/modes.ts` so the engine avoids a
 * circular import; `local` is not a degradation target because it is a
 * different axis from price, not a cheaper tier.
 */
function degradeChainOf(mode: Mode): Mode[] {
  if (mode === "stop") return ["stop"]
  const order: Record<Mode, number> = { power: 3, cheap: 2, free: 1, local: 0, stop: -1 }
  const current = order[mode]
  const cheaper = (Object.keys(order) as Mode[]).filter((m) => order[m] < current && order[m] > 0)
  if (cheaper.length === 0) return [mode]
  return [mode, cheaper.reduce((best, m) => (order[m] < order[best] ? m : best))]
}

function restrictionRequirements(restrict: "no-vision" | "no-tools" | "text-only"): Requirements {
  if (restrict === "no-vision") return { vision: false }
  if (restrict === "no-tools") return { toolCall: false }
  return { vision: false, audio: false, pdf: false, video: false, toolCall: false }
}

function describe(error: ClassifiedError): string {
  return error.message || error.kind
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A per-process identity for the loop's owner field.
 *
 * Deliberately opaque and never persisted in code: the only thing that
 * matters is that two opencode instances cannot produce the same one, so a
 * loop can never look like it belongs to the process reading it.
 */
function newInstanceID(): string {
  return `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * The deadline to store for a cooldown of `ms`.
 *
 * A sentinel is a fact about the model, not a duration. Storing
 * `now + sentinel` produces a value larger than the sentinel it was made
 * from, so `liftPermanentCooldowns` could never match a spent quota's
 * exclusion and paid modes kept inheriting it. Sentinels are stored as
 * themselves; ordinary durations stay deadlines.
 */
function cooldownDeadline(ms: number): number {
  return ms >= DEPRECATED_COOLDOWN_MS ? ms : Date.now() + ms
}
