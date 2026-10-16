/**
 * dont-stop — Clocks.
 *
 * Three clocks keep a loop from getting stuck, and they fail differently:
 *
 * - **interval**: the heartbeat. Every `intervalMs` the engine re-evaluates
 *   its plan: re-sweep the catalogue, check whether a better model is now
 *   available, and re-rank per task. This is what makes "continually evaluate
 *   on each turn" true even when nothing else happens.
 *
 * - **idle**: the quiet clock. If a tracked session produces no events at all
 *   for `idleMs`, the loop is not working on anything and stands down. This
 *   is the honest answer to "the session just went away".
 *
 * - **hang**: the clock that matters. A *wall-clock* timeout is the wrong
 *   tool: a big refactor or a long subagent fan-out legitimately takes many
 *   minutes with no output, and a fixed 120s hang limit would interrupt real
 *   work. So the hang clock does not measure elapsed time. It measures
 *   **silence within activity**: it only arms once the session is known to be
 *   running, and it disarms on *any* progress signal — a new message, a token,
 *   a tool call, a subagent start. A running session that is genuinely
 *   producing output never trips it, however long it runs. A session that is
 *   running and producing *nothing at all* for `hangMs` trips it.
 *
 * That distinction is the whole point: the hang clock catches the stuck
 * request, not the long one.
 */

export interface ClockOptions {
  /** Heartbeat cadence. */
  intervalMs: number
  /** Silent-but-idle sessions stand down after this. */
  idleMs: number
  /** Silent-while-running sessions are interrupted after this. */
  hangMs: number
}

export const DEFAULT_CLOCKS: ClockOptions = {
  intervalMs: 30_000,
  idleMs: 10 * 60_000,
  hangMs: 3 * 60_000,
}

/** Progress signals that all mean "the session is alive". */
export type ProgressKind =
  | "message"
  | "token"
  | "tool"
  | "subagent"
  | "reasoning"
  | "permission"
  | "step"

export interface SessionActivity {
  sessionID: string
  /** Epoch ms of the last progress signal of any kind. */
  lastProgress: number
  /** Epoch ms of the last event at all, including non-progress events. */
  lastSeen: number
  /** Whether the session is currently running a request. */
  running: boolean
  /** Consecutive hang-triggered interrupts for this session. */
  hangs: number
}

export type ClockVerdict =
  | { action: "wait"; reason: string }
  | { action: "idle"; reason: string }
  | { action: "hang"; reason: string; silentMs: number }

/**
 * One session's clock state. The clocks never read the wall clock directly;
 * `now` is injected so the engine controls time and tests can drive it.
 */
export class SessionClocks {
  readonly activity: SessionActivity

  constructor(
    sessionID: string,
    private readonly options: ClockOptions,
    now: number,
  ) {
    this.activity = {
      sessionID,
      lastProgress: now,
      lastSeen: now,
      running: false,
      hangs: 0,
    }
  }

  /** Record any event for this session. */
  seen(now: number): void {
    this.activity.lastSeen = now
  }

  /** Record a progress signal, which disarms both idle and hang clocks. */
  progress(now: number): void {
    this.activity.lastProgress = now
    this.activity.lastSeen = now
  }

  /** The session began (or resumed) a request. */
  start(now: number): void {
    this.activity.running = true
    this.activity.lastProgress = now
    this.activity.lastSeen = now
  }

  /**
   * The session finished its request.
   *
   * A completed turn is proof the model recovered, so the hang budget resets
   * here. `hangs` therefore counts *consecutive* hangs with nothing finished
   * between them, which is the only number worth stopping a loop over.
   */
  finish(now: number): void {
    this.activity.running = false
    this.activity.hangs = 0
    this.activity.lastSeen = now
  }

  /**
   * A hang interrupt was delivered.
   *
   * The request is *cancelled*, so the clock stops claiming one is running:
   * leaving `running` true is what turned a single stuck turn into a hang
   * every `hangMs` forever — no completion event ever arrives for a request
   * that was aborted, so the clock never disarmed and re-fired on its own
   * stale belief. A later `start()` re-arms it when a real turn begins.
   */
  interrupted(now: number): void {
    this.activity.hangs += 1
    this.activity.running = false
    this.activity.lastProgress = now
    this.activity.lastSeen = now
  }

  /**
   * Judge the session at time `now`.
   *
   * The hang clock only applies while running and only on total silence:
   * `now - lastProgress >= hangMs`. Because every progress kind refreshes
   * `lastProgress`, a session producing output is never judged hung.
   */
  verdict(now: number): ClockVerdict {
    const { running, lastProgress, lastSeen } = this.activity
    const silentFor = now - lastProgress
    const absentFor = now - lastSeen

    if (running) {
      if (silentFor >= this.options.hangMs) {
        return {
          action: "hang",
          reason: `running but silent for ${Math.round(silentFor / 1000)}s`,
          silentMs: silentFor,
        }
      }
      return { action: "wait", reason: "running and progressing" }
    }

    if (absentFor >= this.options.idleMs) {
      return { action: "idle", reason: `no events for ${Math.round(absentFor / 1000)}s` }
    }
    return { action: "wait", reason: "idle, awaiting work" }
  }

  /**
   * Whether another hang interrupt is worth attempting. A session that has
   * already been interrupted several times without recovering is not hung on
   * a model — it is stuck on the task — and interrupting again would only
   * destroy work. The engine uses this to stop escalating.
   */
  exhausted(): boolean {
    return this.activity.hangs >= 3
  }
}

/**
 * The registry of per-session clocks plus the engine-wide heartbeat. This is
 * the object the engine owns; `SessionClocks` is the per-session detail.
 */
export class ClockSet {
  private readonly sessions = new Map<string, SessionClocks>()
  /** Epoch ms of the last heartbeat evaluation. */
  private lastBeat: number

  constructor(
    private readonly options: ClockOptions = DEFAULT_CLOCKS,
    now: number = Date.now(),
  ) {
    this.lastBeat = now
  }

  clocksFor(sessionID: string): SessionClocks {
    let clocks = this.sessions.get(sessionID)
    if (!clocks) {
      clocks = new SessionClocks(sessionID, this.options, Date.now())
      this.sessions.set(sessionID, clocks)
    }
    return clocks
  }

  /** Drop a session's clocks when it goes away. */
  forget(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  /** A session's clocks, without creating them. */
  peek(sessionID: string): SessionClocks | undefined {
    return this.sessions.get(sessionID)
  }

  get size(): number {
    return this.sessions.size
  }

  /** Has the heartbeat interval elapsed? */
  dueForBeat(now: number = Date.now()): boolean {
    return now - this.lastBeat >= this.options.intervalMs
  }

  beat(now: number = Date.now()): void {
    this.lastBeat = now
  }

  /**
   * Evaluate every tracked session once. Returns the sessions that need
   * action, so the engine can interrupt hung ones and stand down idle ones.
   */
  evaluate(
    now: number = Date.now(),
  ): Array<{ sessionID: string; verdict: ClockVerdict; exhausted: boolean }> {
    const results: Array<{ sessionID: string; verdict: ClockVerdict; exhausted: boolean }> = []
    for (const clocks of this.sessions.values()) {
      const verdict = clocks.verdict(now)
      if (verdict.action === "wait") continue
      results.push({
        sessionID: clocks.activity.sessionID,
        verdict,
        exhausted: clocks.exhausted(),
      })
    }
    return results
  }
}

/**
 * Turn an event into clock signals.
 *
 * The event vocabulary itself is owned by `lib/events.ts` — decoding lives
 * there so the names the server emits are listed in one place. This module
 * only maps a decoded signal onto a clock tick: `seen`, `progress`, `start`
 * and `finish` are the only ways a clock ever moves.
 */
