/**
 * dont-stop — Loop engine.
 *
 * The engine owns the loop: it watches sessions, detects hangs, keeps turning
 * the prompt, manages sessions, and recovers from failures. It holds
 * no model-selection logic — that lives in the sibling model-selector plugin,
 * which observes the same error events and rotates models in-process. This
 * plugin never writes to it, imports it, or depends on it being installed.
 *
 * Lifecycle: `start()` arms the loop on a session, the heartbeat evaluates it
 * on the interval, events feed the clocks and the session tracker, and
 * `stop()` disarms it.
 *
 * Two rules keep it from running away, and both come from the same idea —
 * *the loop may only touch what it owns*:
 *
 * - **Ownership.** A loop belongs to the instance that started it (`owner`).
 *   Advancing and interrupting happen only there, so a second live
 *   opencode process reports a loop but never drives it. A loop left behind by
 *   a dead owner is recovered on boot: adopted when its session still exists,
 *   halted when it does not.
 * - **A budget per failure, not per recovery.** Each model gets one try per
 *   episode, so a chain of ten is walked and then stops instead of being
 *   cycled.
 */

import { ClockSet, DEFAULT_CLOCKS, type ClockOptions } from "./clocks.ts"

import type { Logger } from "./log.ts"
import { bumpIntent, readState, type LoopState, type PluginState } from "./state.ts"
import { eventSignals, TURN_END_TYPES, type SessionEvent } from "./events.ts"

/** What a scheduled re-drive carries: the short nudge or the full mission. */
export type RedriveKind = "nudge" | "mission"

/**
 * A pending re-drive: the deadline and the strength of the prompt owed.
 *
 * A nudge is enough on nearly every re-drive: the previous turn's prompt is
 * already in context above the model's response, so the mission doesn't go
 * stale through rotation alone. It is only needed when the turn was cut off
 * before it could land (the hang path, user escape) or the transcript itself
 * changed (compaction, restart) — those moments where the mission is taken
 * out of the model's immediate attention.
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

/* -------------------------------------------------------------------- types */

/** A session the engine is tracking for the loop. */
export interface TrackedSession {
  sessionID: string
  lastSeen: number
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
  /** Turns in one session before the transcript is compacted. */
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
 * Report-only by design: reaching it logs a warning and the loop continues.
 * There is no iteration cap — a budget would silently halt long-running work.
 */
export const DEFAULT_MAX_ITERATIONS = 100

/** Turns in one session before the transcript is compacted. */
export const DEFAULT_SESSION_STEPS = 30

/** How many turns between scheduled full-prompt reinjections. */
export const DEFAULT_REINJECT_EVERY = 10

/** How long to wait before re-driving the loop — after cancelling a hung turn. */
export const DEFAULT_REDRIVE_DELAY_MS = 20_000

/** How soon a failed turn is re-driven on the freshly rotated model. */
export const DEFAULT_FAILURE_REDRIVE_DELAY_MS = 1_500

/** How long a re-drive waits before re-checking a session that was still running. */
export const REDRIVE_POLL_MS = 1_000

/** The grace added to every re-drive timer, so it fires after its deadline. */
export const REDRIVE_TIMER_GRACE_MS = 1

/** How long a model that hung stays out of the chain (10 minutes). */
export const DEFAULT_HANG_COOLDOWN_MS = 10 * 60_000

/** How long after boot the restart detector stands down. */
export const DEFAULT_RESEED_GRACE_MS = 90_000

/** How long a loop session waits before a second compaction request. */
export const COMPACTION_REQUEST_COOLDOWN_MS = 5 * 60_000

/** The served context assumed for a local model whose window the daemon does not report. */
export const LOCAL_WINDOW_UNKNOWN_GUARD = 64_000

/** How recent an interrupt must be to count as the hang path's own doing. */
export const HANG_INTERRUPT_RECENCY_MS = 5_000

/** Heartbeat intervals an owner may miss before its loop counts as orphaned. */
export const LEASE_GRACE_BEATS = 3

/** The loop drive prompt. */
export const CONTINUE_PROMPT = "Continue."

/** The full mission, restated: the loop's own prompt plus the keep-going instruction. */
export function missionText(prompt: string): string {
  return `${prompt}\n\nKeep working.`
}

/* ------------------------------------------------------------ engine class */

export class LoopEngine {
  private readonly tracked = new Map<string, TrackedSession>()
  private readonly clocks: ClockSet
  private failedTurns = new Set<string>()
  private armedSessions = new Set<string>()
  private hangInterrupts = new Map<string, number>()
  private redrives = new Map<string, Redrive>()
  private readonly turnToolUse = new Set<string>()
  private readonly lastReinjections = new Map<string, number>()
  private redriveTimers = new Map<string, ReturnType<typeof setTimeout>>()

  readonly instanceID: string
  private appliedIntent: number
  private advancing = new Set<string>()
  private reportedForeignLoop = false
  private readonly startedAt = Date.now()

  private readonly maxIterations: number
  private readonly sessionSteps: number
  private readonly reinjectEvery: number
  private readonly redriveDelayMs: number
  private readonly failureRedriveDelayMs: number
  private readonly leaseGraceMs: number
  private readonly reseedGraceMs: number
  private readonly compactions = new Map<string, number>()
  private readonly messageCounts = new Map<string, number>()
  private readonly compactionRequests = new Map<string, number>()

  constructor(
    private readonly ctx: unknown,
    private readonly state: PluginState,
    private readonly log: Logger,
    private readonly options: EngineOptions = {},
  ) {
    const clocks = options.clocks ?? DEFAULT_CLOCKS
    this.clocks = new ClockSet(clocks)
    this.instanceID = options.instanceID ?? newInstanceID()
    // Start with no intent applied so a halt that survived a service restart
    // is replayed by the next live instance. Re-applying a halt that already
    // stopped its targets is harmless (no active targets, just a log), but
    // dropping it leaves the TUI stuck on "halting…" with active loops that
    // will never be stopped.
    this.appliedIntent = 0
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
    this.sessionSteps = options.sessionSteps ?? DEFAULT_SESSION_STEPS
    this.reinjectEvery = options.reinjectEvery ?? DEFAULT_REINJECT_EVERY
    this.redriveDelayMs = options.redriveDelayMs ?? DEFAULT_REDRIVE_DELAY_MS
    this.failureRedriveDelayMs = options.failureRedriveDelayMs ?? DEFAULT_FAILURE_REDRIVE_DELAY_MS
    this.reseedGraceMs = options.reseedGraceMs ?? DEFAULT_RESEED_GRACE_MS
    this.leaseGraceMs = clocks.intervalMs * LEASE_GRACE_BEATS
    for (const id of options.seedSessions ?? []) {
      this.track(id)
    }
  }

  /* ------------------------------------------------------------- accessors */

  get status(): LoopState | null {
    return this.primaryLoop()
  }

  primaryLoop(): LoopState | null {
    const loops = Object.values(this.state.loops)
    if (loops.length === 0) return null
    const active = loops.filter((l) => l.status === "active")
    const pool = active.length > 0 ? active : loops
    return [...pool].sort(
      (a, b) => (b.ownerBeatAt || b.startedAt || 0) - (a.ownerBeatAt || a.startedAt || 0),
    )[0]
  }

  trackedSessions(): TrackedSession[] {
    return [...this.tracked.values()]
  }

  loops(): LoopState[] {
    return Object.values(this.state.loops)
  }

  loopFor(sessionID: string): LoopState | undefined {
    return this.state.loops[sessionID]
  }

  ownsLoop(sessionID: string): boolean {
    const loop = this.state.loops[sessionID]
    return !!loop && loop.status === "active" && loop.sessionID === sessionID &&
      loop.owner === this.instanceID
  }

  /** Loop sessions this instance is driving — the only ones it may shut down. */
  ownedActiveSessions(): string[] {
    return Object.keys(this.state.loops).filter((id) => this.ownsLoop(id))
  }

  /* ------------------------------------------------------------ attribution */

  track(sessionID: string, agent = "general"): TrackedSession {
    let record = this.tracked.get(sessionID)
    if (!record) {
      record = { sessionID, lastSeen: Date.now(), agent }
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
      if (this.loopFor(sessionID)) this.armedSessions.add(sessionID)
      const record = this.tracked.get(sessionID)
      if (record) {
        if (signals.agent) record.agent = signals.agent
      }
    } else if (signals.lifecycle === "finish") {
      clocks.finish(now)
    } else {
      const record = this.tracked.get(sessionID)
      if (record) {
        if (signals.agent) record.agent = signals.agent
      }
    }

    if (signals.progress === "tool" && this.state.loops[sessionID]) {
      this.turnToolUse.add(sessionID)
    }

    if (event.type === "session.compacted") this.compactions.set(sessionID, Date.now())
  }

  /* --------------------------------------------------------------- turn end */

  async onTurnEnd(sessionID: string, eventType: string): Promise<void> {
    if (!TURN_END_TYPES.has(eventType)) return
    if (!this.ownsLoop(sessionID)) return
    if (!this.armedSessions.has(sessionID)) return
    this.armedSessions.delete(sessionID)

    if (eventType === "session.execution.interrupted") {
      const ours = Date.now() - (this.hangInterrupts.get(sessionID) ?? 0) < HANG_INTERRUPT_RECENCY_MS
      const loop = this.loopFor(sessionID)
      if (loop) loop.turnStartedAt = null
      if (ours) return
      if (!this.redrives.has(sessionID)) this.scheduleRedrive(sessionID, this.redriveDelayMs)
      return
    }

    await this.advance(sessionID)
  }

  /* ----------------------------------------------------- best-effort cancel */

  private async interrupt(sessionID: string): Promise<void> {
    try {
      await (this.ctx as { session?: { interrupt(input: { sessionID: string }): Promise<unknown> } })
        .session?.interrupt({ sessionID })
    } catch (error) {
      this.log.warn(`interrupt failed for ${sessionID}: ${msg(error)}`)
    }
  }

  /* ------------------------------------------------------- control intents */

  async applyIntent(onDisk: PluginState = readState()): Promise<boolean> {
    const intent = onDisk.intent
    if (!intent || intent.seq <= this.appliedIntent) return false
    this.appliedIntent = intent.seq
    this.state.intent = intent

    if (intent.action === "halt") {
      const actives = Object.entries(this.state.loops).filter(([, l]) => l.status === "active")
      if (actives.length === 0) return true
      // A halt applies only to loops its request postdates (mirroring the
      // TUI's `halting…` condition: `intent.at > loop.startedAt`). Loops
      // started after the request — including ones started by a fresh instance
      // that re-reads this intent from disk — are new work, not targets, so a
      // stale halt can never kill a new loop. An intent without a timestamp
      // falls back to halting everything rather than dropping the request.
      const issuedAt = intent.at ?? 0
      const targets = issuedAt > 0
        ? actives.filter(([, l]) => (l.startedAt ?? 0) < issuedAt)
        : actives
      if (targets.length === 0) {
        this.log.info(`halt intent ${intent.seq} postdates every active loop; ignoring it`)
        return true
      }
      this.log.warn(`halt intent ${intent.seq} halting ${targets.length} loop(s) started before the request`)
      // announce=false: the request is already the newest word on the control
      // plane, so re-bumping a fresh halt here would mint a poison intent that
      // outlives the loops it stopped and re-fires on later ones.
      for (const [sessionID] of targets) {
        await this.stop(`halted by intent ${intent.seq}`, sessionID, onDisk, false)
      }
    }
    return true
  }

  /* ---------------------------------------------------------- orphans */

  async reapOrphanedLoops(onDisk: PluginState = readState()): Promise<void> {
    for (const [sessionID, disk] of Object.entries(onDisk.loops)) {
      if (!disk || disk.status !== "active") continue

      const memory = this.state.loops[sessionID]
      if (memory?.owner === this.instanceID || disk.owner === this.instanceID) continue

      const beatAt = disk.ownerBeatAt ?? 0
      if (beatAt > 0 && Date.now() - beatAt <= this.leaseGraceMs) {
        if (!this.reportedForeignLoop) {
          this.reportedForeignLoop = true
          this.log.info(
            `a loop is running on ${sessionID} under instance ${disk.owner}; this instance reports but does not drive it`,
          )
        }
        continue
      }

      const stale = beatAt > 0 ? `${Math.round((Date.now() - beatAt) / 1000)}s` : "never"
      this.log.warn(
        `loop on ${sessionID} is orphaned ` +
          `(owner ${disk.owner ?? "none"} last beat ${stale} ago); reaping it`,
      )
      await this.stop("loop orphaned: owner heartbeat expired; reaped", sessionID)
    }
  }

  async recoverOrphanedLoops(onDisk: PluginState = readState()): Promise<void> {
    for (const [sessionID, disk] of Object.entries(onDisk.loops)) {
      if (!disk || disk.status !== "active") continue

      const memory = this.state.loops[sessionID]
      if (memory?.owner === this.instanceID || disk.owner === this.instanceID) continue

      const beatAt = disk.ownerBeatAt ?? 0
      if (beatAt > 0 && Date.now() - beatAt <= this.leaseGraceMs) {
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
      if (!this.tracked.has(sessionID)) this.track(sessionID)
      this.messageCounts.set(sessionID, count)
      this.log.warn(`recovered loop on ${sessionID} left by instance ${disk.owner ?? "none"}; adopting it`)
      this.scheduleRedrive(sessionID, this.redriveDelayMs)
      this.emit()
    }
  }

  /* --------------------------------------------------------------- errors */

  /**
   * Tiny local detector for stale-reasoning-state errors.
   * Full error classification is owned by model-selector/lib/errors.ts.
   */
  private static staleReasoningRegexp = /reasoning.{0,40}(not found|expired)/i

  async onError(input: {
    sessionID?: string
    agent?: string
    message?: string
    status?: number
    type?: string
    error?: unknown
  }): Promise<void> {
    const message = input.message ?? String(input.error ?? "")
    if (!input.sessionID) return

    if (LoopEngine.staleReasoningRegexp.test(message) && this.ownsLoop(input.sessionID)) {
      const compacted = await this.compactSession(input.sessionID)
      if (compacted) {
        this.scheduleRedrive(input.sessionID, this.failureRedriveDelayMs, "mission")
        this.emit()
        return
      }
      this.log.warn(`compaction unavailable for ${input.sessionID}; passing to model-selector`)
      return
    }

    this.log.warn(`error on ${input.sessionID}: ${message || "(no details)"}`)
  }

  /* ------------------------------------------------------------- heartbeat */

  async beat(): Promise<void> {
    const now = Date.now()
    this.clocks.beat(now)

    const onDisk = readState()
    await this.applyIntent(onDisk)
    await this.reapOrphanedLoops(onDisk)

    // Adopt the loops known on disk that we are not already tracking, so an
    // in-memory snapshot that lags (a fresh instance, or one that missed a
    // cross-instance start) catches up without clobbering anything it owns.
    if (onDisk.loops && typeof onDisk.loops === "object") {
      for (const [id, diskRow] of Object.entries(onDisk.loops)) {
        const local = this.state.loops[id]
        if (!local) this.state.loops[id] = diskRow
        else if (local.owner !== this.instanceID) {
          if (local.status === "stopped" && diskRow.status === "active") {
            // halt/retirement in memory must not be reverted by stale disk
          } else if ((diskRow.ownerBeatAt ?? 0) > (local.ownerBeatAt ?? 0)) {
            this.state.loops[id] = diskRow
          }
        }
      }
    }

    const now2 = Date.now()
    for (const sessionID of Object.keys(this.state.loops)) {
      const loop = this.state.loops[sessionID]
      if (loop.status !== "active" || loop.owner !== this.instanceID) continue
      loop.ownerBeatAt = now2
      await this.maybeRedrive(sessionID)
      await this.maybeReseedRestarted(sessionID)
    }

    const verdicts = this.clocks.evaluate(now)
    for (const { sessionID, verdict } of verdicts) {
      if (verdict.action === "idle") {
        if (this.loopFor(sessionID)) continue
        this.log.info(`session ${sessionID} idle: ${verdict.reason}`)
        this.untrack(sessionID)
        continue
      }

      if (verdict.action === "hang") {
        if (!this.ownsLoop(sessionID)) continue
        await this.handleHang(sessionID, verdict.reason)
      }
    }

    this.emit()
  }

  /**
   * Handle a hanging session. Interrupt the tree, record the interrupt, then
   * schedule a re-drive — an aborted request never emits the idle event the
   * loop is driven by. Model selection is not this plugin's concern: if the
   * hang was a model failure, model-selector sees the same error events and
   * rotates on its own.
   */
  private async handleHang(sessionID: string, reason: string): Promise<void> {
    this.log.warn(`hang detected on ${sessionID}: ${reason}`)

    this.hangInterrupts.set(sessionID, Date.now())
    await this.interrupt(sessionID)
    this.clocks.clocksFor(sessionID).interrupted(Date.now())

    const current = this.loopFor(sessionID)
    if (!current || !this.ownsLoop(sessionID)) return

    // An aborted request never emits the idle event the loop is driven by, so
    // without a scheduled re-drive the loop would go silent right here.
    this.scheduleRedrive(sessionID, this.redriveDelayMs)
    this.emit()
  }

  private scheduleRedrive(sessionID: string, delayMs: number, kind: RedriveKind = "nudge"): void {
    this.redrives.set(sessionID, { at: Date.now() + delayMs, kind })
    this.armRedrive(sessionID, delayMs)
  }

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

  private clearRedrive(sessionID: string): void {
    this.redrives.delete(sessionID)
    const timer = this.redriveTimers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      this.redriveTimers.delete(sessionID)
    }
  }

  private async redriveNow(sessionID: string): Promise<void> {
    const pending = await this.maybeRedrive(sessionID)
    if (!pending) return
    const redrive = this.redrives.get(sessionID)
    if (!redrive) return
    const remaining = redrive.at - Date.now()
    this.armRedrive(sessionID, remaining > 0 ? remaining : REDRIVE_POLL_MS)
  }

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

    const text = redrive.kind === "mission"
      ? (this.missionOf(sessionID) ?? CONTINUE_PROMPT)
      : CONTINUE_PROMPT

    try {
      this.log.info(`re-driving ${sessionID} after a cancelled turn`)
      await this.sendPrompt(sessionID, text)
      this.clocks.clocksFor(sessionID).start(Date.now())
      return false
    } catch (error) {
      this.log.warn(`re-drive failed on ${sessionID}: ${msg(error)}; will try again`)
      this.redrives.set(sessionID, { at: Date.now() + this.redriveDelayMs, kind: redrive.kind })
      return true
    }
  }

  /* ----------------------------------------------------------- restart detection */

  private async maybeReseedRestarted(sessionID: string): Promise<void> {
    const loop = this.loopFor(sessionID)
    if (!loop || !this.ownsLoop(sessionID)) return
    if (loop.prompt.trim().length === 0) return
    if (Date.now() - this.startedAt < this.reseedGraceMs) return
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

  private async messageCount(sessionID: string): Promise<number> {
    try {
      const raw: unknown = await this.readMessages(sessionID)
      const list = Array.isArray(raw) ? raw : (raw as { data?: unknown } | null)?.data
      return Array.isArray(list) ? list.length : 0
    } catch {
      return -1
    }
  }

  /* -------------------------------------------------------------- advance */

  async advance(sessionID: string): Promise<void> {
    if (this.advancing.has(sessionID)) return
    if (!this.ownsLoop(sessionID)) return
    const loop = this.loopFor(sessionID)!

    this.advancing.add(sessionID)
    this.state.loops[sessionID]!.turnStartedAt = null
    this.clearRedrive(sessionID)
    try {
      loop.iterations += 1
      loop.sessionIterations += 1
      if (!this.failedTurns.has(sessionID)) this.resetEpisode()
      const iteration = loop.iterations
      loop.lastResult = `iteration ${iteration} complete`
      this.emit()

      if (iteration >= this.maxIterations) {
        // Deliberately not a halt: the budget only reports, so a loop doing
        // long but healthy work is never capped into silence.
        this.log.warn(`iteration ${iteration} reached the ${this.maxIterations} budget; continuing`)
      }

      if (loop.consecutiveErrors >= 5) {
        this.log.warn(`${loop.consecutiveErrors} consecutive errors and continuing`)
      }

      let compactedNow = false
      if (loop.sessionIterations >= this.sessionSteps) {
        compactedNow = await this.compactSession(sessionID)
        loop.sessionIterations = 0
        this.log.info(`compacted ${sessionID}: step budget exceeded, reset sessionIterations`)
      }

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
      this.scheduleRedrive(sessionID, this.failureRedriveDelayMs, "mission")
      this.emit()
    } finally {
      this.advancing.delete(sessionID)
    }
  }

  private missionOf(sessionID: string): string | null {
    const loop = this.loopFor(sessionID)
    if (!loop || loop.prompt.trim().length === 0) return null
    this.lastReinjections.set(sessionID, loop.iterations)
    return missionText(loop.prompt)
  }

  private resetEpisode(): void {
    for (const loop of this.loops()) loop.rotations = 0
  }

  private async readMessages(sessionID: string): Promise<unknown> {
    const api = this.ctx as {
      session: { context(input: { sessionID: string }): Promise<unknown> }
    }
    return api.session.context({ sessionID })
  }

  /* -------------------------------------------------------- loop lifecycle */

  async start(sessionID: string, prompt: string): Promise<void> {
    const existing = this.state.loops[sessionID]
    if (existing?.status === "active" && existing.owner !== this.instanceID) {
      this.log.warn(
        `a loop is already running on ${sessionID} under instance ${existing.owner ?? "none"}; ` +
          `stop it before starting another`,
      )
      return
    }
    if (existing?.status === "stopped") {
      this.log.info(`resetting stopped loop ${sessionID} before starting fresh`)
    }

    this.track(sessionID)
    this.state.loops[sessionID] = {
      status: "active",
      sessionID,
      sessionNumber: 1,
      prompt,
      iterations: 0,
      sessionIterations: 0,
      startedAt: Date.now(),
      lastResult: "loop started",
      owner: this.instanceID,
      ownerBeatAt: Date.now(),
      rotations: 0,
      consecutiveErrors: 0,
      turnStartedAt: null,
    }
    this.failedTurns.delete(sessionID)
    this.clearRedrive(sessionID)
    this.lastReinjections.delete(sessionID)
    this.resetEpisode()
    this.appliedIntent = bumpIntent(this.state, "start").seq
    this.clocks.clocksFor(sessionID).start(Date.now())
    this.log.info(`loop started on ${sessionID}: ${prompt.slice(0, 80)}`)

    try {
      // Every new loop starts from a compacted transcript, so stale context
      // from prior work never pollutes the fresh run. Forced: bypasses the
      // step-budget cooldown — a new loop always wants a clean slate.
      // Failure is non-fatal (logged inside compactSession); the loop still
      // starts.
      await this.compactSession(sessionID, true)
      await this.sendPrompt(sessionID, prompt)
      this.clocks.clocksFor(sessionID).start(Date.now())
      const count = await this.messageCount(sessionID)
      if (count >= 0) this.messageCounts.set(sessionID, count)
    } catch (error) {
      this.log.error(`could not send the opening prompt: ${msg(error)}`)
      await this.stop(`failed to send the opening prompt: ${msg(error)}`, sessionID)
      return
    }
    this.emit()
  }

  async stop(reason: string, sessionID?: string, onDiskArg?: PluginState, announce = true): Promise<void> {
    const onDiskLoops = (onDiskArg ?? readState()).loops
    const targets = sessionID ? (this.state.loops[sessionID] ? [sessionID] : []) : Object.keys(this.state.loops)
    let acted = false
    let unsettled = false
    for (const sid of targets) {
      const loop = this.state.loops[sid]
      if (loop.status !== "active") continue
      acted = true

      const settled = onDiskLoops[sid]?.status === "stopped"
      if (settled) {
        this.state.loops[sid] = { ...onDiskLoops[sid]! }
      } else {
        unsettled = true
        loop.status = "stopped"
        loop.lastResult = reason
        // Keep ownership so writeState and beat merges prefer this stopped
        // row over the stale active row still on disk. An orphaned loop
        // halted by a new instance would otherwise be resurrected because
        // writeState always defers non-owned rows to disk.
        loop.owner = this.instanceID
        loop.ownerBeatAt = Date.now()
        loop.rotations = 0
        loop.turnStartedAt = null
      }
      this.clearRedrive(sid)
      this.armedSessions.delete(sid)
      this.hangInterrupts.delete(sid)
      this.turnToolUse.delete(sid)
      this.lastReinjections.delete(sid)

      await this.interrupt(sid)
      this.clocks.forget(sid)
      this.untrack(sid)
    }
    if (acted) this.resetEpisode()

    if (unsettled && announce) {
      this.appliedIntent = bumpIntent(this.state, "halt").seq
      this.log.info(`loop${targets.length > 1 ? "s" : ""} stopped: ${reason}`)
      this.emit()
    } else if (unsettled) {
      this.log.info(`loop${targets.length > 1 ? "s" : ""} stopped: ${reason}`)
      this.emit()
    }
  }

  async sendPrompt(sessionID: string, text: string): Promise<void> {
    this.failedTurns.delete(sessionID)
    this.turnToolUse.delete(sessionID)
    this.armedSessions.add(sessionID)
    const loop = this.loopFor(sessionID)
    if (loop) {
      loop.turnStartedAt = Date.now()
      this.emit()
    }
    const session = this.ctx as {
      session: { prompt(input: { sessionID: string; text: string }): Promise<unknown> }
    }
    await session.session.prompt({ sessionID, text })
  }

  /* ---------------------------------------------------------- compaction */

  private async compactSession(sessionID: string, force = false): Promise<boolean> {
    if (!force) {
      const last = this.compactionRequests.get(sessionID) ?? 0
      if (Date.now() - last < COMPACTION_REQUEST_COOLDOWN_MS) return false
    }
    this.compactionRequests.set(sessionID, Date.now())
    try {
      const api = this.ctx as {
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

  /** Persist and notify. */
  private emit(): void {
    this.options.onStateChange?.(this.state)
  }
}

/* ------------------------------------------------------------------ helpers */

function newInstanceID(): string {
  return `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

