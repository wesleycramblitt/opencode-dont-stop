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
 */

import {
  applyAvailability,
  loadCatalogue,
  markAvailable,
  markUnavailable,
  cooldown,
  filter,
  sortBy,
  sorts,
  exportSummary,
  type AvailabilityPatch,
  type Catalogue,
  type Requirements,
} from "./catalogue.ts"
import {
  AGENT_KINDS,
  profileFor,
  rankForMode,
  type AgentKind,
  type TaskProfile,
} from "./modes.ts"
import { actionFor, classify, type ClassifiedError, type ErrorAction } from "./errors.ts"
import { ClockSet, DEFAULT_CLOCKS, lifecycleOf, progressKindOf, type ClockOptions } from "./clocks.ts"
import {
  DEFAULT_HANDOFF_THRESHOLD,
  handoff,
  measureContext,
  shouldHandoff,
  transcriptFrom,
  type HandoffContext,
} from "./handoff.ts"
import { handoffDirectory } from "./state.ts"
import { applyAgentDefaults, applySessionModels, sameSlot, slotFrom, type ApplyContext, type ModelPlan } from "./apply.ts"
import type { Logger } from "./log.ts"
import { appendLog, type Mode, type ModelSlot, type PluginState } from "./state.ts"

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
}

/**
 * How many iterations a loop may run before it stops itself.
 *
 * A bound, not a target: the loop's real stopping condition is the completion
 * sentinel, and this exists so a model that never emits it cannot run forever.
 */
export const DEFAULT_MAX_ITERATIONS = 100

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

export class LoopEngine {
  private catalogue: Catalogue | null = null
  private readonly tracked = new Map<string, TrackedSession>()
  private readonly clocks: ClockSet
  private rotation: Record<string, number> = {}
  private restrictions: Record<string, Requirements> = {}
  private running = false
  private abort = new AbortController()

  private readonly maxIterations: number
  private readonly sentinel: string
  private readonly handoffThreshold: number
  private readonly handoffDirectory: string
  /** Guards against sending two prompts for one idle event. */
  private advancing = false

  constructor(
    private readonly ctx: ApplyContext,
    private readonly state: PluginState,
    private readonly log: Logger,
    private readonly options: EngineOptions = {},
  ) {
    this.clocks = new ClockSet(options.clocks ?? DEFAULT_CLOCKS, log)
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
    this.sentinel = options.completionSentinel ?? COMPLETION_SENTINEL
    this.handoffThreshold = options.handoffThreshold ?? DEFAULT_HANDOFF_THRESHOLD
    this.handoffDirectory = options.handoffDirectory ?? handoffDirectory()
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
  observe(event: { type: string; properties?: Record<string, unknown> }): void {
    const sessionID = (event.properties?.info as { id?: string } | undefined)?.id
      ?? (event.properties?.sessionID as string | undefined)
    if (!sessionID) return

    this.track(sessionID)

    const lifecycle = lifecycleOf(event.type)
    const progress = progressKindOf(event.type, event.properties)
    const clocks = this.clocks.clocksFor(sessionID)

    if (progress) clocks.progress(Date.now())
    else clocks.seen(Date.now())

    if (lifecycle === "start") {
      clocks.start(Date.now())
      const record = this.tracked.get(sessionID)
      if (record) {
        const info = event.properties?.info as { model?: { providerID?: string; id?: string }; agent?: string } | undefined
        if (info?.model) {
          record.model = { providerID: info.model.providerID ?? "", id: info.model.id ?? "" }
        }
        if (info?.agent) record.agent = info.agent
      }
    } else if (lifecycle === "finish") {
      clocks.finish(Date.now())
    }

    this.state.lastEvent = event.type
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
      const result = await (this.ctx as unknown as { catalog?: { model: { list(): Promise<{ data?: unknown }> } } }).catalog?.model.list()
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
      this.log.info(`reachability: ${reachable} routable, ${unroutable} not routable from this install`)
      this.emit()
    } catch (error) {
      this.log.quiet("info", `reachability check unavailable: ${msg(error)}`)
    }
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

  /** Restore a model to available. */
  restore(key: string): void {
    if (this.catalogue) markAvailable(this.catalogue, key)
  }

  /** Mark a model unavailable with a reason. */
  fail(key: string, reason: string): void {
    if (this.catalogue) markUnavailable(this.catalogue, key, reason)
  }

  /**
   * Rebuild the catalogue from the generated data file.
   *
   * The data file is produced by `scripts/update-catalogue.ts`, which is a
   * deliberate CLI step rather than something the running plugin does: it
   * hits the network for every source and writes a committed artifact, so a
   * plugin reload must not silently rewrite it. This method reloads whatever
   * is on disk and re-plans, which is what makes the command useful.
   */
  async refreshCatalogue(): Promise<Catalogue | null> {
    const next = loadCatalogue()
    if (!next) {
      this.log.warn("no catalogue on disk; run: npx tsx scripts/update-catalogue.ts")
      return this.catalogue
    }
    const patches = this.availabilityPatches()
    this.catalogue = next
    applyAvailability(next, patches)
    this.log.info(`catalogue reloaded: ${next.models.length} models`)
    this.emit()
    return next
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

    const needsSwitch: Array<{ sessionID: string; model: ModelSlot }> = []
    for (const entry of plan.sessions) {
      const record = this.tracked.get(entry.sessionID)
      if (!record) continue
      if (!force && record.model && sameSlot(record.model, entry.model)) continue
      needsSwitch.push(entry)
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
    this.state.rotation = this.rotation
    this.emit()
  }

  /* ------------------------------------------------------------- heartbeat */

  /** One heartbeat: re-plan, apply, and judge the clocks. */
  async beat(): Promise<void> {
    this.clocks.beat(Date.now())

    // Re-evaluate on the interval, per the power/free/cheap mode contracts.
    await this.refresh(false)

    const verdicts = this.clocks.evaluate(Date.now())
    for (const { sessionID, verdict, exhausted } of verdicts) {
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
        if (exhausted) {
          this.log.warn(`session ${sessionID} still hung after repeated interrupts; stopping loop`)
          this.stop(`session ${sessionID} unresponsive after repeated interrupts`)
          return
        }
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
   */
  private async handleHang(sessionID: string, reason: string): Promise<void> {
    this.log.warn(`hang detected on ${sessionID}: ${reason}`)
    this.clocks.clocksFor(sessionID).interrupted(Date.now())

    try {
      await (this.ctx.session as unknown as { interrupt(input: { sessionID: string }): Promise<unknown> })
        .interrupt({ sessionID })
    } catch (error) {
      this.log.warn(`interrupt failed for ${sessionID}: ${msg(error)}`)
    }

    this.rotate(sessionID, "hang")
    this.emit()
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

    this.log.warn(`${classified.kind}${input.sessionID ? ` on ${input.sessionID}` : ""}: ${classified.message || describe(classified)}`)

    if (action.cooldownMs > 0 && input.sessionID) {
      const record = this.tracked.get(input.sessionID)
      const key = record?.model ? `${record.model.providerID}/${record.model.id}` : null
      if (key) {
        this.state.cooldowns[key] = Date.now() + action.cooldownMs
      }
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
      this.state.consecutiveErrors += 1
      if (this.state.consecutiveErrors >= 5) {
        this.stop(`too many consecutive errors: ${this.state.consecutiveErrors}`)
        return action
      }
    } else {
      this.state.consecutiveErrors = 0
    }

    if (action.resweep && input.sessionID) {
      this.rotate(input.sessionID, classified.kind)
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
        if (this.catalogue) markAvailable(this.catalogue, key)
      }
    }
    if (changed) this.emit()
  }

  /* ------------------------------------------------------------- rotation */

  /**
   * Move a session to the next model in its mode's chain. `cause` is logged
   * and recorded so a rotation is always explicable after the fact.
   */
  rotate(sessionID: string, cause: string): void {
    const record = this.tracked.get(sessionID)
    if (!record) return
    const agent = record.agent
    const cursorKey = `${agent}:${this.state.mode}`
    const cursor = (this.rotation[cursorKey] ?? 0) + 1
    this.rotation[cursorKey] = cursor

    if (!this.catalogue) return
    const ranked = rankForMode(this.catalogue, this.state.mode, this.taskFor(agent))
    if (ranked.length === 0) {
      this.log.warn(`no model left in the ${this.state.mode} chain for ${agent}`)
      return
    }
    const next = ranked[cursor % ranked.length]
    record.model = slotFrom(next)
    this.state.loop.lastResult = `rotated ${agent} to ${next.providerID}/${next.id} (${cause})`
    this.log.info(this.state.loop.lastResult)

    void applySessionModels(
      this.ctx as unknown as ApplyContext,
      [{ sessionID, model: record.model }],
      this.log,
    )
  }

  /* ----------------------------------------------------------- mode changes */

  /** Switch mode, reset per-mode state, and re-plan. */
  async setMode(mode: Mode): Promise<void> {
    if (this.state.mode === mode) return
    this.state.mode = mode
    this.state.degraded = false
    this.state.preferredMode = null
    this.rotation = {}
    this.state.consecutiveErrors = 0
    this.log.info(`mode set to ${mode}`)
    await this.refresh(true)
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
    this.rotation = {}
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
    if (this.state.loop.status !== "active") return
    if (this.state.loop.sessionID !== sessionID) return

    this.advancing = true
    try {
      this.state.loop.iterations += 1
      const iteration = this.state.loop.iterations
      this.state.loop.lastResult = `iteration ${iteration} complete`
      this.emit()

      if (iteration >= this.maxIterations) {
        this.stop(`iteration budget reached (${iteration})`)
        return
      }

      const lastText = await this.lastAssistantText(sessionID)
      if (lastText.includes(this.sentinel)) {
        this.stop(`task complete after ${iteration} iterations`)
        return
      }

      if (this.state.consecutiveErrors >= 5) {
        this.stop(`stopping after ${this.state.consecutiveErrors} consecutive errors`)
        return
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
      if (this.state.consecutiveErrors >= 5) {
        this.stop(`stopping after ${this.state.consecutiveErrors} consecutive loop errors`)
      }
      this.emit()
    } finally {
      this.advancing = false
    }
  }

  /** Send one prompt to a session. */
  async sendPrompt(sessionID: string, text: string): Promise<void> {
    const session = this.ctx as unknown as {
      session: { prompt(input: { sessionID: string; text: string }): Promise<unknown> }
    }
    await session.session.prompt({ sessionID, text })
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
    this.track(sessionID)
    this.state.loop = {
      status: "active",
      sessionID,
      prompt,
      iterations: 0,
      startedAt: Date.now(),
      lastResult: null,
    }
    this.state.consecutiveErrors = 0
    this.running = true
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
      this.stop(`failed to send the opening prompt: ${msg(error)}`)
      return
    }
    this.emit()
  }

  async stop(reason: string): Promise<void> {
    if (this.state.loop.status === "stopped") return
    this.state.loop.status = "stopped"
    this.state.loop.lastResult = reason
    this.state.loop.sessionID = null
    this.running = false
    this.log.info(`loop stopped: ${reason}`)
    this.emit()
  }

  /** One completed iteration. Called by the engine's driver. */
  completeIteration(): void {
    this.state.loop.iterations += 1
    this.emit()
  }

  /* --------------------------------------------------------------- plumbing */

  /** Subscribe to server events and pump them into `observe`. */
  consume(events: AsyncIterable<{ type: string; properties?: Record<string, unknown> }>): Promise<void> {
    return (async () => {
      try {
        for await (const event of events) {
          this.observe(event)
          if (event.type === "session.error" || event.type === "message.error") {
            const props = event.properties as
              | { info?: { id?: string }; sessionID?: string; error?: { message?: string; status?: number; type?: string } }
              | undefined
            await this.onError({
              sessionID: props?.sessionID ?? props?.info?.id,
              message: props?.error?.message,
              status: props?.error?.status,
              type: props?.error?.type,
            })
          }
          if (event.type === "session.idle" && this.running) {
            this.completeIteration()
          }
        }
      } catch (error) {
        if (!this.abort.signal.aborted) {
          this.log.warn(`event consumer stopped: ${msg(error)}`)
        }
      }
    })()
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
 * The response is an array of messages, each carrying a `role` and `parts`.
 * Part shapes vary — text parts, reasoning parts, tool parts — so only text and
 * a `content` string are collected, and the *last* assistant message wins
 * because that is the turn that just finished.
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

    const parts = record.parts
    if (Array.isArray(parts)) {
      let collected = ""
      for (const part of parts) {
        if (!part || typeof part !== "object") continue
        const p = part as Record<string, unknown>
        if (typeof p.text === "string") collected += p.text
        else if (typeof p.content === "string") collected += p.content
      }
      if (collected.length > 0) text = collected
    } else if (typeof record.text === "string") {
      text = record.text
    } else if (typeof record.content === "string") {
      text = record.content
    }
  }
  return text
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`
}

export { appendLog }
