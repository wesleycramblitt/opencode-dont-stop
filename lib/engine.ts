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
 *   Advancing, interrupting and rotating happen only there, so a second
 *   opencode process — or a fresh one after a restart — never adopts a loop
 *   it did not start, and an orphaned loop is halted rather than inherited.
 * - **A budget per failure, not per recovery.** Every model gets one try per
 *   episode — rotation moves to a model that has not been attempted since the
 *   last completed turn, so a chain of ten is walked and then stops instead of
 *   being cycled. Rotations are also counted against completed turns, so a
 *   wide chain cannot buy an unbounded number of losing bets either.
 */

import {
  applyAvailability,
  loadCatalogue,
  markAvailable,
  markUnavailable,
  cooldown,
  clearCooldown,
  filter,
  sortBy,
  sorts,
  exportSummary,
  type AvailabilityPatch,
  type Catalogue,
  type CatalogueModel,
  type Requirements,
} from "./catalogue.ts"
import {
  AGENT_KINDS,
  profileFor,
  rankForMode,
  type AgentKind,
  type TaskProfile,
} from "./modes.ts"
import { actionFor, classify, PERMANENT_COOLDOWN_MS, type ClassifiedError, type ErrorAction } from "./errors.ts"
import { ClockSet, DEFAULT_CLOCKS, type ClockOptions } from "./clocks.ts"
import {
  DEFAULT_HANDOFF_THRESHOLD,
  handoff,
  measureContext,
  shouldHandoff,
  sessionTree as fetchSessionTree,
  transcriptFrom,
  type HandoffContext,
} from "./handoff.ts"
import { handoffDirectory } from "./state.ts"
import { applyAgentDefaults, applySessionModels, sameSlot, slotFrom, type ApplyContext, type ModelPlan } from "./apply.ts"
import type { Logger } from "./log.ts"
import { bumpIntent, readState, type Mode, type ModelSlot, type PluginState } from "./state.ts"
import { eventSignals, TURN_END_TYPES, type SessionEvent } from "./events.ts"

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
  /** Token the model emits to declare the task finished. */
  completionSentinel?: string
  /** Fraction of the context window at which to start a fresh session. */
  handoffThreshold?: number
  /** Where handoff summaries are written. */
  handoffDirectory?: string
  /** Identifies this process as the loop's owner. Generated when omitted. */
  instanceID?: string
  /**
   * Delay before re-driving the loop: after cancelling a hung turn, and
   * before a second attempt on a model that just failed.
   */
  redriveDelayMs?: number
  /** How long a model that hung stays out of the chain. */
  hangCooldownMs?: number
}

/**
 * How many iterations a loop may run before it stops itself.
 *
 * A bound, not a target: the loop's real stopping condition is the completion
 * sentinel, and this exists so a model that never emits it cannot run forever.
 */
export const DEFAULT_MAX_ITERATIONS = 100

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

/** How long a model that hung stays out of the chain (10 minutes). */
export const DEFAULT_HANG_COOLDOWN_MS = 10 * 60_000

/**
 * How recent an interrupt must be to count as the hang path's own doing.
 *
 * The hang path records the moment it interrupts; the resulting
 * `session.execution.interrupted` event can arrive a beat later, so the check
 * is a small recency window rather than an exact match.
 */
export const HANG_INTERRUPT_RECENCY_MS = 5_000

/** Heartbeat intervals an owner may miss before its loop counts as orphaned. */
export const LEASE_GRACE_BEATS = 3

/**
 * The completion sentinel.
 *
 * The loop cannot know on its own whether a task is finished — that is a
 * judgement about the work, and the only entity with the context is the model
 * doing it. So the loop asks: the prompt instructs the model to emit this exact
 * token when, and only when, the task is genuinely complete. Reading for it is
 * deterministic and needs no extra model call, which a "is it done?" probe
 * would.
 */
export const COMPLETION_SENTINEL = "<loop-complete/>"

/** Instruction appended to every loop prompt so the model knows the protocol. */
export const SENTINEL_INSTRUCTION =
  `\n\nWhen the task above is fully complete, reply with exactly ${COMPLETION_SENTINEL} ` +
  `and nothing else. Do not emit it while work remains.`

/**
 * Sent to advance a loop that has not finished. Deliberately short: the session
 * already holds the full task context, and a long standing instruction tends to
 * make the model restart rather than continue.
 */
export const CONTINUE_PROMPT = "Continue. If the task is now fully complete, reply with only " + COMPLETION_SENTINEL

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
  /**
   * Models that have already had a try since the last completed turn, keyed
   * `provider/model`. Rotation only moves to an *untried* model, so a chain of
   * ten gives ten tries and then stops instead of cycling through the same few
   * forever. Unreachable and cooling-down models never enter this set: they are
   * filtered out of the chain before rotation sees them, so they cost nothing.
   */
  private tried = new Set<string>()
  /**
   * Failures per model this episode, keyed `provider/model`. One is a flake
   * worth a second attempt on the same model; two means rotate. Cleared with
   * the episode.
   */
  private retries: Record<string, number> = {}
  /**
   * Whether the turn that just ended died of an error rather than completing.
   * Cleared when a prompt is sent, so `advance` can tell a finished turn from
   * an error that merely idled the session — only the former starts a fresh
   * try budget, or a failing model would get an unlimited number of retries.
   */
  private turnFailed = false
  /**
   * Whether a turn of the loop's session is in flight. Set when a prompt is
   * sent and when an execution-start event arrives; cleared by the first
   * turn-end event. Turn-end events come in pairs on the v2 bus (an execution
   * result and a later idle/status), and without this flag each pair would
   * advance the loop twice.
   */
  private turnArmed = false
  /**
   * When the hang path last interrupted the loop session. The interrupt
   * produces a `session.execution.interrupted` event; distinguishing it from
   * a user escape is what lets the engine stand down and let the scheduled
   * re-drive own the next prompt instead of advancing immediately.
   */
  private lastHangInterruptAt = 0

  /**
   * This process's identity. Written into the state file as the loop's owner,
   * it is what lets a second instance — or a new one after a restart — know
   * that a loop it finds on disk belongs to somebody else.
   */
  readonly instanceID: string
  /** Newest control intent this engine has acted on, so its own are not replayed. */
  private appliedIntent: number
  /** Deadline for re-driving the loop after a cancelled turn, or null. */
  private redriveAt: number | null = null
  /** Last announced reachability counts, so a re-check logs only on change. */
  private reachabilityCount: { reachable: number; unroutable: number } | null = null
  /** Guards against sending two prompts for one idle event. */
  private advancing = false
  /** Whether a foreign loop has already been reported, so it is said once. */
  private reportedForeignLoop = false

  private readonly maxIterations: number
  private readonly sentinel: string
  private readonly handoffThreshold: number
  private readonly handoffDirectory: string
  private readonly redriveDelayMs: number
  private readonly hangCooldownMs: number
  private readonly leaseGraceMs: number

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
    this.sentinel = options.completionSentinel ?? COMPLETION_SENTINEL
    this.handoffThreshold = options.handoffThreshold ?? DEFAULT_HANDOFF_THRESHOLD
    this.handoffDirectory = options.handoffDirectory ?? handoffDirectory()
    this.redriveDelayMs = options.redriveDelayMs ?? DEFAULT_REDRIVE_DELAY_MS
    this.hangCooldownMs = options.hangCooldownMs ?? DEFAULT_HANG_COOLDOWN_MS
    this.leaseGraceMs = clocks.intervalMs * LEASE_GRACE_BEATS
    for (const id of options.seedSessions ?? []) {
      this.track(id)
    }
  }

  /* ------------------------------------------------------------- accessors */

  get status(): PluginState["loop"] {
    return this.state.loop
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

  /**
   * May this instance drive the loop right now?
   *
   * The single gate for every loop action — advancing, interrupting, rotating,
   * re-driving. A loop is a live conversation with requests in flight, so it
   * cannot be resumed by whoever reads the state file next; only its owner
   * acts, and everyone else reports.
   */
  ownsLoop(): boolean {
    const loop = this.state.loop
    return loop.status === "active" && loop.sessionID !== null && loop.owner === this.instanceID
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
      // A started turn is a turn in flight: the first turn-end event for the
      // loop's session is the one that gets to advance it.
      if (sessionID === this.state.loop.sessionID) this.turnArmed = true
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

    this.state.lastEvent = event.type
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
    if (!this.ownsLoop() || this.state.loop.sessionID !== sessionID) return
    if (!this.turnArmed) return
    this.turnArmed = false

    if (eventType === "session.execution.interrupted") {
      // An interrupt ends a turn without completing it. When it was ours —
      // the hang path interrupting before a rotation — the re-drive deadline
      // owns the next prompt, and advancing now would double-drive. When it
      // was the user's escape, nothing else is scheduled, so the re-drive
      // gives the loop a moment before continuing it.
      const ours = Date.now() - this.lastHangInterruptAt < HANG_INTERRUPT_RECENCY_MS
      if (ours) return
      if (this.redriveAt === null) this.redriveAt = Date.now() + this.redriveDelayMs
      return
    }

    await this.advance(sessionID)
  }

  /* ------------------------------------------------------------ session tree */

  /** The loop session and every descendant session, at any depth. */
  private async sessionTree(rootID: string): Promise<string[]> {
    const ctx = this.ctx as unknown as Pick<HandoffContext, "session">
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

  /** Build the full plan for the current mode and catalogue. */
  buildPlan(): ModelPlan {
    const notes: string[] = []
    const agents: Record<string, ModelSlot> = {}
    if (!this.catalogue) {
      return { main: null, agents, sessions: [], notes: ["no catalogue yet"] }
    }

    const mode = this.state.mode
    for (const kind of AGENT_KINDS) {
      const task = this.taskFor(kind)
      const ranked = rankForMode(this.catalogue, mode, task)
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
   * Push the current plan through both channels and record the result. Safe
   * to call on every heartbeat: the plan diff keeps it quiet when nothing
   * changed.
   */
  async refresh(force = false): Promise<void> {
    if (!this.catalogue) {
      await this.discover()
      if (!this.catalogue) return
    }

    const plan = this.buildPlan()

    await applyAgentDefaults(this.ctx as unknown as ApplyContext, () => plan)

    // The session channel reaches the loop's own session ONLY. Tracking used
    // to be incidental — `observe` records every session that emits an event —
    // and the plan then switched the pinned model of *every* tracked session,
    // which is how a free-sweep re-plan re-modelled a user's live session that
    // had nothing to do with the loop. Being tracked is not consent: this
    // plugin drives the loop it was asked to start, and nothing else.
    const needsSwitch: Array<{ sessionID: string; model: ModelSlot }> = []
    if (this.state.loop.sessionID !== null && this.ownsLoop()) {
      const target = this.tracked.get(this.state.loop.sessionID)
      const entry = plan.sessions.find((e) => e.sessionID === this.state.loop.sessionID)
      if (entry && target) {
        if (force || !target.model || !sameSlot(target.model, entry.model)) needsSwitch.push(entry)
      }
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

    // Mirror the plan into state so the TUI can render it.
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
    await this.reapOrphanedLoop(onDisk)

    // Re-evaluate on the interval, per the power/free/cheap mode contracts.
    await this.refresh(false)

    if (this.ownsLoop()) {
      this.state.loop.ownerBeatAt = now
      await this.maybeRedrive()
    }

    const verdicts = this.clocks.evaluate(now)
    for (const { sessionID, verdict } of verdicts) {
      if (verdict.action === "idle") {
        // A non-loop session going idle is simply untracked. The loop session
        // is *not* stopped here: idle between turns is the loop's normal state,
        // and the idle event handler (`advance`) is what decides whether the
        // work is finished. Stopping on idle would end the loop on its first
        // turn.
        if (sessionID === this.state.loop.sessionID) continue
        this.log.info(`session ${sessionID} idle: ${verdict.reason}`)
        this.untrack(sessionID)
        continue
      }

      if (verdict.action === "hang") {
        // Only the loop's own session is ours to rescue. Interrupting a
        // session nobody asked this plugin to manage is how a hang detector
        // becomes something that kills unrelated work — including the very
        // turn the user is watching.
        if (sessionID !== this.state.loop.sessionID) continue
        if (!this.ownsLoop()) continue
        await this.handleHang(sessionID, verdict.reason)
      }
    }

    // Rotate past any model whose cooldown has expired and re-sweep.
    this.expireCooldowns()
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
    this.lastHangInterruptAt = Date.now()
    await this.interruptTree(sessionID)
    this.clocks.clocksFor(sessionID).interrupted(Date.now())

    // The await above yields the thread, and a halt may have landed in it.
    // Re-read the loop and re-check ownership rather than rotating a loop
    // that was stopped while the interrupt was in flight.
    const current = this.state.loop
    if (!this.ownsLoop() || current.sessionID !== sessionID) return

    if (previous) {
      this.putOnCooldown(previous, Date.now() + this.hangCooldownMs)
    }

    const outcome = this.rotate(sessionID, "hang")
    if (outcome !== "moved" && outcome !== "not-ours") {
      // Not a stop (owner, 2026-10-11): every model in the chain has had its
      // try and none is cooling down yet (or nothing is left at all). The
      // recovery is to wait for the cooldowns to expire — `expireCooldowns`
      // re-admits models on the next beats — and re-drive. In `free` mode the
      // local fallback is still the chain's tail, so this usually does not
      // happen at all.
      this.log.warn(`no untried model left for ${sessionID}; waiting for cooldowns instead of stopping (${outcome})`)
      if (this.redriveAt === null) this.redriveAt = Date.now() + this.redriveDelayMs
      this.emit()
      return
    }
    current.rotations += 1

    // An aborted request never emits the idle event the loop is driven by, so
    // without a scheduled re-drive the loop would go silent right here. The
    // heartbeat picks this up; `maybeRedrive` stands down if a real turn
    // started in the meantime.
    this.redriveAt = Date.now() + this.redriveDelayMs
    this.emit()
  }

  /**
   * Re-drive the loop when its last turn was cancelled rather than completed.
   *
   * Deliberately conservative: it fires once, at the deadline, and only while
   * the session is genuinely idle — if anything started a turn in the
   * meantime, the normal idle path owns it and this does nothing. The
   * deadline is *kept* rather than consumed in that case, so a re-drive
   * scheduled behind a slow turn is not thrown away.
   */
  private async maybeRedrive(): Promise<void> {
    const at = this.redriveAt
    if (at === null || Date.now() < at) return

    const sessionID = this.state.loop.sessionID
    if (!sessionID || !this.ownsLoop()) {
      this.redriveAt = null
      return
    }
    if (this.clocks.peek(sessionID)?.activity.running) return
    this.redriveAt = null

    try {
      this.log.info(`re-driving ${sessionID} after a cancelled turn`)
      await this.sendPrompt(sessionID, CONTINUE_PROMPT)
      this.clocks.clocksFor(sessionID).start(Date.now())
    } catch (error) {
      // Not a stop (owner, 2026-10-11): a failed continue does not end the
      // loop, it reschedules one — the session may be mid-teardown or the
      // provider briefly unreachable, and the error funnel reports either.
      this.log.warn(`re-drive failed on ${sessionID}: ${msg(error)}; will try again`)
      this.redriveAt = Date.now() + this.redriveDelayMs
      void this.onError({ sessionID, error, message: msg(error) }).catch(() => {})
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
   */
  async applyIntent(onDisk: PluginState = readState()): Promise<void> {
    const intent = onDisk.intent
    if (!intent || intent.seq <= this.appliedIntent) return
    this.appliedIntent = intent.seq
    this.state.intent = intent

    if (intent.action === "halt") {
      if (this.state.loop.status !== "active") return
      this.log.info(`halt requested (intent ${intent.seq})`)
      await this.stop(`halted by intent ${intent.seq}`)
      return
    }

    if (intent.action === "start" && this.state.loop.status !== "active") {
      const loop = onDisk.loop
      if (!loop.sessionID || !loop.prompt) return
      if (!this.tracked.has(loop.sessionID)) {
        this.log.info(`ignoring start intent ${intent.seq}: ${loop.sessionID} is served by another instance`)
        return
      }
      await this.start(loop.sessionID, loop.prompt)
    }
  }

  /**
   * Halt a loop whose owner instance is gone, and otherwise report the loop
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
  async reapOrphanedLoop(onDisk: PluginState = readState()): Promise<void> {
    const memory = this.state.loop
    const disk = onDisk.loop

    // Ours in either copy: this instance writes the lease, so memory is the
    // fresher copy and a lagging file must never overwrite it.
    if (memory.owner === this.instanceID || disk.owner === this.instanceID) return

    // Not ours: the file is the truth to report — the owner writes it, and
    // our copy only ages.
    if (
      disk.status !== memory.status ||
      disk.sessionID !== memory.sessionID ||
      disk.owner !== memory.owner ||
      disk.ownerBeatAt !== memory.ownerBeatAt
    ) {
      this.state.loop = { ...memory, ...disk }
    }

    if (disk.status !== "active") return

    const beatAt = disk.ownerBeatAt ?? 0
    if (beatAt > 0 && Date.now() - beatAt <= this.leaseGraceMs) {
      // Someone else's live loop. Say so once — a footer that reads "active"
      // in a process doing nothing is otherwise a mystery.
      if (!this.reportedForeignLoop) {
        this.reportedForeignLoop = true
        this.log.info(
          `a loop is running on ${disk.sessionID} under instance ${disk.owner}; this instance reports but does not drive it`,
        )
      }
      return
    }

    this.log.warn(
      `loop on ${disk.sessionID ?? "unknown session"} is orphaned ` +
        `(owner ${disk.owner ?? "none"} last beat ${beatAt > 0 ? `${Math.round((Date.now() - beatAt) / 1000)}s` : "never"} ago)`,
    )
    await this.stop("loop orphaned: the instance running it is gone")
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

    const ownsThis = this.ownsLoop() && input.sessionID !== undefined &&
      this.state.loop.sessionID === input.sessionID
    const record = input.sessionID ? this.tracked.get(input.sessionID) : undefined
    const key = record?.model ? modelKeyOf(record.model) : null

    // The loop's turn just died: however the session ends up idling, that turn
    // must not be counted as completed work.
    if (ownsThis) this.turnFailed = true

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
      this.putOnCooldown(key, Date.now() + action.cooldownMs)
    }

    if (action.restrict) {
      const agent = input.agent ?? "general"
      this.restrictions[agent] = { ...(this.restrictions[agent] ?? {}), ...restrictionRequirements(action.restrict) }
      this.log.info(`restricted pool for ${agent}: ${action.restrict}`)
    }

    if (action.degrade) {
      await this.degradeMode(action.reason)
    }

    if (this.consecutive(classified)) {
      // Reported, not stopped (owner, 2026-10-11): the loop survives error
      // streaks. The counter is in the state file, so a degenerate provider
      // run is visible before it becomes a wallpaper.
      if (ownsThis) this.state.consecutiveErrors += 1
    } else if (ownsThis) {
      this.state.consecutiveErrors = 0
    }

    if (willRetry && key) {
      this.retries[key] = failures + 1
      this.log.info(`retrying ${key} once after ${classified.kind} before rotating`)
      // Nothing has changed on the session, so nothing will prompt it: the
      // re-drive is what turns "retry" into an actual second attempt.
      this.redriveAt = Date.now() + this.redriveDelayMs
    } else if (action.resweep && input.sessionID && ownsThis) {
      const outcome = this.rotate(input.sessionID, classified.kind)
      // Not a stop when the chain has nothing left (owner, 2026-10-11): the
      // loop waits for cooldowns to expire instead. `"not-ours"` is a rotation
      // that was never ours to make, and quietly does nothing.
      if (outcome !== "moved" && outcome !== "not-ours") {
        this.log.warn(`no untried model left for ${input.sessionID}; waiting for cooldowns instead of stopping (${outcome})`)
        if (this.redriveAt === null) this.redriveAt = Date.now() + this.redriveDelayMs
        this.emit()
        return action
      }
    }

    this.emit()
    return action
  }

  private consecutive(error: ClassifiedError): boolean {
    return error.kind === "other" || error.kind === "auth" || error.kind === "notfound"
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
  rotate(sessionID: string, cause: string): RotationOutcome {
    // Only the loop's owner moves a session's model. Rotation from an error on
    // some other session — or from another instance watching the same file —
    // is this plugin reaching into work it was not asked to manage.
    if (!this.ownsLoop() || this.state.loop.sessionID !== sessionID) return "not-ours"

    const record = this.tracked.get(sessionID)
    if (!record) return "not-ours"
    const agent = record.agent

    if (!this.catalogue) return "unavailable"
    const ranked = rankForMode(this.catalogue, this.state.mode, this.taskFor(agent))
    if (ranked.length === 0) {
      this.log.warn(`no model left in the ${this.state.mode} chain for ${agent}`)
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
    let pick: CatalogueModel | null = null
    for (const candidate of ranked) {
      if (this.tried.has(`${candidate.providerID}/${candidate.id}`)) continue
      pick = candidate
      break
    }
    if (!pick) {
      this.state.loop.lastResult =
        `every model in the ${this.state.mode} chain for ${agent} has had its try (${ranked.length} models)`
      this.log.warn(this.state.loop.lastResult)
      return "exhausted"
    }

    record.model = slotFrom(pick)
    this.tried.add(modelKeyOf(pick))
    this.state.loop.lastResult = `rotated ${agent} to ${pick.providerID}/${pick.id} (${cause})`
    this.log.info(this.state.loop.lastResult)

    void applySessionModels(
      this.ctx as unknown as ApplyContext,
      [{ sessionID, model: record.model }],
      this.log,
    )
    return "moved"
  }

  /* ----------------------------------------------------------- mode changes */

  /** Switch mode, reset per-mode state, and re-plan. */
  async setMode(mode: Mode): Promise<void> {
    if (this.state.mode === mode) return
    this.state.mode = mode
    this.state.degraded = false
    this.state.preferredMode = null
    this.state.consecutiveErrors = 0
    // A permanent free-quota exclusion belongs to the free sweep, and only to
    // it: in `cheap` the same model is a paid row and is selectable again. So
    // leaving free mode lifts every permanent cooldown; ordinary timed
    // cooldowns are untouched.
    if (mode !== "free") this.liftPermanentCooldowns()
    // A new chain is a new bet, so the episode's try budget starts over.
    this.resetEpisode()
    this.log.info(`mode set to ${mode}`)
    await this.refresh(true)
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

  /** Drop to a cheaper mode, recording where we degraded from. */
  private async degradeMode(reason: string): Promise<void> {
    const chain = degradeChainOf(this.state.mode)
    if (chain.length <= 1) {
      this.log.warn(`cannot degrade below ${this.state.mode}: ${reason}`)
      return
    }
    const next = chain[1]
    if (!this.state.degraded) this.state.preferredMode = this.state.mode
    this.state.degraded = true
    this.log.warn(`degrading ${this.state.mode} -> ${next}: ${reason}`)
    this.state.mode = next
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
   * 1. Count the completed iteration.
   * 2. Read the last assistant turn and look for the completion sentinel. Its
   *    presence means the model judged the work finished, which stops the loop.
   * 3. Stop if the iteration budget or the error budget is spent.
   * 4. Otherwise **re-plan** — re-rank the catalogue, sweep for a model that
   *    has become available or a better one for the task, and switch the
   *    session if the answer changed. This is the "continually evaluate on each
   *    turn" contract, and it runs before the prompt so the next turn is already
   *    on the current best model.
   * 5. Send the next prompt, which makes the session busy again and re-arms the
   *    hang clock.
   *
   * `advancing` guards the re-entrancy: an idle event can arrive while a prompt
   * is in flight, and two prompts for one turn would double the work and
   * desynchronise the counters.
   */
  async advance(sessionID: string): Promise<void> {
    if (this.advancing) return
    if (!this.ownsLoop()) return
    if (this.state.loop.sessionID !== sessionID) return

    this.advancing = true
    // A real turn completed, so any pending re-drive of a cancelled one is
    // stale: this idle event is the driver now.
    this.redriveAt = null
    try {
      this.state.loop.iterations += 1
      // Finished work is the evidence that the model was not the problem, so
      // the episode's try budget starts over. A turn that merely *errored* into
      // idleness does not count as finished — otherwise a failing model would
      // clear its own failure count every time it gave up, and earn an
      // unlimited number of retries.
      if (!this.turnFailed) this.resetEpisode()
      const iteration = this.state.loop.iterations
      this.state.loop.lastResult = `iteration ${iteration} complete`
      this.emit()

      if (iteration >= this.maxIterations) {
        // Not a stop (owner, 2026-10-11): the loop runs until it is halted or
        // the task's own completion sentinel appears. The iteration counter is
        // still reported so a runaway is visible in the footer.
        this.log.warn(`iteration ${iteration} reached the ${this.maxIterations} budget; continuing`)
      }

      const lastText = await this.lastAssistantText(sessionID)
      if (lastText.includes(this.sentinel)) {
        await this.stop(`task complete after ${iteration} iterations`)
        return
      }

      if (this.state.consecutiveErrors >= 5) {
        // Not a stop (owner, 2026-10-11): the loop survives its own error
        // streaks. The count is reported so the condition is visible.
        this.log.warn(`${this.state.consecutiveErrors} consecutive errors and continuing`)
      }

      // Hand off before continuing when the context window is spent. This is
      // deliberately after the completion check and before the next prompt: a
      // handoff mid-turn would destroy the work in flight, and doing it at all
      // is only safe once the session has been idle long enough to know no
      // subagent is still writing into it.
      const handoff = await this.checkHandoff(sessionID)
      if (handoff === "handed-off") return

      // Re-plan before continuing, so the next turn runs on the current best
      // model rather than whatever happened to be selected earlier.
      await this.refresh(false)

      await this.sendPrompt(sessionID, CONTINUE_PROMPT)
      this.clocks.clocksFor(sessionID).start(Date.now())
      // A deferred handoff is worth surfacing: the loop is continuing on a
      // window that is already past its threshold, and the reason (usually a
      // live subagent) is the thing a user would want to know.
      const deferred = handoff === "deferred" ? ` (handoff deferred: ${this.state.loop.lastResult ?? "unknown"})` : ""
      this.state.loop.lastResult = `iteration ${iteration} done; continuing${deferred}`
      this.log.info(`loop iteration ${iteration} complete; continuing`)
      this.emit()
    } catch (error) {
      this.log.error(`advance failed on ${sessionID}: ${msg(error)}`)
      this.state.consecutiveErrors += 1
      this.emit()
    } finally {
      this.advancing = false
    }
  }

  /** Send one prompt to a session. */
  async sendPrompt(sessionID: string, text: string): Promise<void> {
    // A prompt starts a turn, so whatever happened to the last one is settled.
    // This is what lets `advance` tell "the turn finished" from "the turn
    // errored into idleness". Arming the turn here also guards against the
    // pair of turn-end events an ending produces: the first one advances, the
    // second is a duplicate that must not.
    this.turnFailed = false
    this.turnArmed = true
    const session = this.ctx as unknown as {
      session: { prompt(input: { sessionID: string; text: string }): Promise<unknown> }
    }
    await session.session.prompt({ sessionID, text })
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
    this.state.loop.rotations = 0
  }

  /**
   * Read the session's messages and return the last assistant turn's text.
   *
   * Returns an empty string on any failure: a model that cannot be read is
   * treated as "not complete" rather than "complete", so the loop keeps going
   * and stops on its budget instead of halting on a read error.
   */
  private async lastAssistantText(sessionID: string): Promise<string> {
    try {
      const api = this.ctx as unknown as {
        session: { context(input: { sessionID: string }): Promise<unknown> }
      }
      const messages = (await api.session.context({ sessionID })) as unknown
      return extractAssistantText(messages)
    } catch (error) {
      this.log.quiet("info", `could not read messages for ${sessionID}: ${msg(error)}`)
      return ""
    }
  }

  /**
   * Hand off to a fresh session when this one has spent enough of its context.
   *
   * Returns "handed-off" when the loop now runs on a new session, "deferred"
   * when a handoff was wanted but unsafe (a subagent is still live, or the
   * summary could not be written), and "not-needed" when the window still has
   * room. A deferral is not an error: the caller continues in the current
   * session and the next turn tries again, which is why a busy subagent merely
   * delays the handoff rather than losing it.
   */
  private async checkHandoff(sessionID: string): Promise<"handed-off" | "deferred" | "not-needed"> {
    const limit = this.contextLimitFor(sessionID)
    if (limit <= 0) return "not-needed"

    const used = await this.contextUsed(sessionID)
    if (used <= 0) return "not-needed"
    if (!shouldHandoff(used, limit, this.handoffThreshold)) return "not-needed"

    this.log.info(`context ${used}/${limit} (${Math.round((used / limit) * 100)}%); handing off`)

    try {
      const messages = await this.readMessages(sessionID)
      const { turns, files } = transcriptFrom(messages)
      const record = this.tracked.get(sessionID)

      const result = await handoff(this.ctx as unknown as HandoffContext, {
        sessionID,
        task: this.state.loop.prompt,
        iterations: this.state.loop.iterations,
        reason: `Context reached ${Math.round((used / limit) * 100)}% of a ${limit}-token window.`,
        transcript: turns,
        files,
      }, { directory: this.handoffDirectory, agent: record?.agent })

      if (!result.handed) {
        this.state.loop.lastResult = result.deferred ?? "unknown"
        this.log.warn(`handoff deferred: ${result.deferred ?? "unknown"}`)
        this.emit()
        return "deferred"
      }

      // The successor session carries the loop forward; the old one is done.
      const newSessionID = result.newSessionID!
      this.untrack(sessionID)
      this.track(newSessionID, record?.agent ?? "general")
      this.state.loop.sessionID = newSessionID
      // The handoff seeds the successor with its own prompt, so its opening
      // turn is a turn of the loop: arm it here, or the first turn-end event
      // would be a duplicate ending and the loop would stand down.
      this.turnArmed = true
      this.state.loop.lastResult = `handed off to ${newSessionID} (summary: ${result.summaryFile})`
      this.log.info(`handed off to ${newSessionID}; summary at ${result.summaryFile}`)
      this.clocks.clocksFor(newSessionID).start(Date.now())
      this.emit()
      return "handed-off"
    } catch (error) {
      this.log.warn(`handoff failed: ${msg(error)}`)
      this.state.loop.lastResult = `handoff failed: ${msg(error)}`
      this.emit()
      return "deferred"
    }
  }

  /** The context window of the session's current model, or 0 when unknown. */
  private contextLimitFor(sessionID: string): number {
    const slot = this.tracked.get(sessionID)?.model
    if (!slot || !this.catalogue) return 0
    const row = this.catalogue.byKey.get(`${slot.providerID}/${slot.id}`)
      ?? this.catalogue.byKey.get(`${slot.providerID}/${slot.id}#${slot.variant ?? ""}`)
    return row?.context ?? 0
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

  async start(sessionID: string, prompt: string): Promise<void> {
    const loop = this.state.loop
    if (loop.status === "active" && loop.owner !== this.instanceID) {
      this.log.warn(
        `a loop is already running on ${loop.sessionID} under instance ${loop.owner ?? "none"}; ` +
          `stop it before starting another`,
      )
      return
    }

    this.track(sessionID)
    this.state.loop = {
      status: "active",
      sessionID,
      prompt,
      iterations: 0,
      startedAt: Date.now(),
      lastResult: null,
      owner: this.instanceID,
      ownerBeatAt: Date.now(),
      rotations: 0,
    }
    this.state.consecutiveErrors = 0
    this.redriveAt = null
    this.resetEpisode()
    // Announce ownership in the control plane, so every other instance reads
    // this loop as somebody else's and leaves it alone.
    this.appliedIntent = bumpIntent(this.state, "start").seq
    this.clocks.clocksFor(sessionID).start(Date.now())
    this.log.info(`loop started on ${sessionID}: ${prompt.slice(0, 80)}`)

    // Plan first so the opening turn already runs on the right model.
    await this.refresh(true)

    // Then send the opening prompt. The sentinel instruction is appended so the
    // model knows how to declare the task finished; without it the loop could
    // only ever stop on its budget.
    try {
      await this.sendPrompt(sessionID, `${prompt}${SENTINEL_INSTRUCTION}`)
      this.clocks.clocksFor(sessionID).start(Date.now())
    } catch (error) {
      this.log.error(`could not send the opening prompt: ${msg(error)}`)
      await this.stop(`failed to send the opening prompt: ${msg(error)}`)
      return
    }
    this.emit()
  }

  /**
   * Disarm the loop and clean up after it, whether or not it was running.
   *
   * The cleanup is the point. The old form returned early when the status was
   * already "stopped", which silently dropped the two things that actually end
   * the *behaviour*: the in-flight request is cancelled, and the session's
   * clocks are dropped so the hang detector stops judging a turn nobody is
   * waiting on. Halting appeared to work — the status flipped — while the
   * interrupt-and-rotate cycle it was meant to end kept firing.
   */
  async stop(reason: string): Promise<void> {
    const loop = this.state.loop
    // Nothing is running: an idle stop — a plugin teardown, a second halt for
    // a loop that already ended, a duplicate command — must not overwrite the
    // last real result. `loop.lastResult` is what the terminal announces, and
    // one teardown writing "plugin unloaded" over it is how a single unload
    // became an endless toast.
    if (loop.status !== "active") return
    const sessionID = loop.sessionID

    loop.status = "stopped"
    loop.lastResult = reason
    loop.sessionID = null
    loop.owner = null
    loop.ownerBeatAt = 0
    loop.rotations = 0
    this.redriveAt = null
    // The episode's try budget belongs to a loop that is over.
    this.resetEpisode()

    // Announce the halt on the control plane: bumping the sequence is what
    // lets this survive a status write that raced it, and tells every other
    // instance the loop is over rather than merely idle.
    this.appliedIntent = bumpIntent(this.state, "halt").seq

    if (sessionID) {
      // The halt applies to the whole tree, not just the root: subagents of
      // the loop's session were spawned by it, and a loop that is over must
      // not leave a fan-out writing into abandoned work. Only live members
      // are interrupted; the rest only lose their clocks.
      await this.interruptTree(sessionID)
      this.clocks.forget(sessionID)
      const tree = await this.sessionTree(sessionID)
      for (const id of tree) {
        if (id === sessionID) continue
        this.untrack(id)
      }
      // The loop session itself is kept tracked: a dropped session would make
      // the next `start` fail with "no session to run the loop on" until the
      // user happened to talk to it again.
    }

    this.log.info(`loop stopped: ${reason}`)
    this.emit()
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

/**
 * Pull the last assistant turn's text out of a session context response.
 *
 * The response is an array of messages, each carrying a `role` (v2 spells it
 * `type`) and parts under `content` (v2) or `parts` (older shapes). Only text
 * parts contribute: reasoning parts are not the answer, and a model that
 * thinks through the completion sentinel must not be read as having emitted
 * it.
 *
 * Deliberately tolerant of shape: an unexpected structure returns an empty
 * string rather than throwing, and an empty string means "not complete", which
 * keeps the loop running to its budget instead of stopping on a parse failure.
 */
function extractAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    // Some APIs wrap the array in `{ data: [...] }`.
    const wrapped = messages as { data?: unknown } | null
    if (wrapped && Array.isArray(wrapped.data)) return extractAssistantText(wrapped.data)
    return ""
  }

  let text = ""
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const record = message as Record<string, unknown>
    const role = record.role ?? record.type
    if (role !== "assistant" && role !== "agent") continue

    const collected = textParts(record.content)
    if (collected.length === 0) {
      // Older shape: parts under `parts` instead of `content`.
      const legacy = textParts(record.parts)
      if (legacy.length > 0) text = legacy
    } else {
      text = collected
    }
    if (typeof record.text === "string") text = record.text
  }
  return text
}

/** Concatenate the text parts of a message, skipping reasoning and tool parts. */
function textParts(value: unknown): string {
  if (!Array.isArray(value)) return ""
  let out = ""
  for (const part of value) {
    if (!part || typeof part !== "object") continue
    const p = part as Record<string, unknown>
    const type = p.type
    if (type !== undefined && type !== "text") continue
    if (typeof p.text === "string") out += p.text
    else if (typeof p.content === "string") out += p.content
  }
  return out
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
