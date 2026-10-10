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
  filter,
  markAvailable,
  markUnavailable,
  sorts,
  sortBy,
  type Catalogue,
  type Requirements,
} from "./catalogue.ts"
import { profileFor, rankForMode, type AgentKind, type TaskProfile } from "./modes.ts"
import { actionFor, classify, type ClassifiedError, type ErrorAction } from "./errors.ts"
import { ClockSet, DEFAULT_CLOCKS, lifecycleOf, progressKindOf, type ClockOptions } from "./clocks.ts"
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

/** How the engine discovers models. Injected so it can be faked or swapped. */
export interface DiscoverySource {
  /** Rows from the server's model registry. */
  registry(): Promise<Array<{ providerID: string; model: unknown }>>
  /** Rows from local providers such as ollama. */
  local(providerID: string): Promise<Array<{ id: string; name?: string; capabilities?: string[]; context?: number; parameterSize?: string }>>
}

export interface EngineContext extends ApplyContext {
  model: { list(): Promise<{ data?: unknown }> | { data?: unknown } }
  event: { subscribe(input: { signal: AbortSignal }): AsyncIterable<{ type: string; properties?: Record<string, unknown> }> }
}

export interface EngineOptions {
  clocks?: ClockOptions
  /** Called when the engine changes something the TUI should show. */
  onStateChange?: (state: PluginState) => void
  /** Session ids to track, for tests. */
  seedSessions?: string[]
}

export class LoopEngine {
  private catalogue: Catalogue | null = null
  private readonly tracked = new Map<string, TrackedSession>()
  private readonly clocks: ClockSet
  private rotation: Record<string, number> = {}
  private restrictions: Record<string, Requirements> = {}
  private running = false
  private abort = new AbortController()

  constructor(
    private readonly ctx: EngineContext,
    private readonly state: PluginState,
    private readonly log: Logger,
    private readonly options: EngineOptions = {},
  ) {
    this.clocks = new ClockSet(options.clocks ?? DEFAULT_CLOCKS, log)
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
   * Discover models from the registry and local providers, then index them.
   * Existing rows keep their availability so a probe failure during a refresh
   * does not erase a known-good model.
   */
  async discover(source?: DiscoverySource): Promise<Catalogue> {
    const rows: Catalogue["models"] = []
    const previous = this.catalogue
    const src = source ?? defaultSource(this.ctx)

    try {
      const registry = await src.registry()
      for (const entry of registry) {
        const model = entry.model as Parameters<typeof import("./catalogue.ts").fromRegistry>[1]
        const row = (await import("./catalogue.ts")).fromRegistry(entry.providerID, model)
        const existing = previous?.byKey.get(row.key)
        if (existing) row.availability = existing.availability
        rows.push(row)
      }
    } catch (error) {
      this.log.warn(`registry discovery failed: ${msg(error)}`)
    }

    try {
      const local = await src.local("ollama")
      for (const entry of local) {
        const row = (await import("./catalogue.ts")).fromLocal("ollama", entry.id, entry)
        const existing = previous?.byKey.get(row.key)
        if (existing) row.availability = existing.availability
        rows.push(row)
      }
    } catch (error) {
      this.log.quiet("info", `local discovery unavailable: ${msg(error)}`)
    }

    this.catalogue = (await import("./catalogue.ts")).index(rows)
    this.log.info(`discovered ${this.catalogue.models.length} models`)
    this.emit()
    return this.catalogue
  }

  /* --------------------------------------------------------------- planning */

  /** The task profile for an agent, given any active restriction. */
  private taskFor(agent: string, vision = false): TaskProfile {
    const kind = agentKind(agent)
    return profileFor(kind, { vision })
  }

  /** Build the full plan for the current mode and catalogue. */
  buildPlan(): ModelPlan {
    const notes: string[] = []
    const agents: Record<string, ModelSlot> = {}
    if (!this.catalogue) {
      return { main: null, agents, sessions: [], notes: ["no catalogue yet"] }
    }

    const mode = this.state.mode
    for (const agent of this.knownAgents()) {
      const restriction = this.restrictions[agent]
      const base = visionRequired(this.state, agent)
      const vision = restriction?.vision !== undefined ? restriction.vision : base
      const task = this.taskFor(agent, vision)
      const ranked = rankForMode(this.catalogue, mode, task)
      if (ranked.length === 0) {
        notes.push(`${agent}: no model satisfies ${mode} requirements`)
        continue
      }
      const slot = slotFrom(ranked[0])
      agents[agent] = slot
      notes.push(`${agent}: ${slot.providerID}/${slot.id} (cap ${ranked[0].capability})`)
    }

    const main = agents["__main__"] ?? Object.values(agents)[0] ?? null
    if (main) agents["__main__"] = main

    const sessions = [...this.tracked.keys()].map((sessionID) => ({
      sessionID,
      model: agents[this.tracked.get(sessionID)?.agent ?? "general"] ?? main,
    })).filter((entry): entry is { sessionID: string; model: ModelSlot } => entry.model !== null)

    return { main, agents, sessions, notes }
  }

  private knownAgents(): string[] {
    const set = new Set<string>(["__main__", "general"])
    for (const record of this.tracked.values()) set.add(record.agent)
    return [...set]
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
        this.log.info(`session ${sessionID} idle: ${verdict.reason}`)
        if (sessionID === this.state.loop.sessionID) {
          this.stop("loop session went idle")
          return
        }
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
    const vision = visionRequired(this.state, agent)
    const ranked = rankForMode(this.catalogue, this.state.mode, this.taskFor(agent, vision))
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
    this.running = true
    this.clocks.clocksFor(sessionID).start(Date.now())
    this.log.info(`loop started on ${sessionID}: ${prompt}`)
    await this.refresh(true)
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

function visionRequired(state: PluginState, _agent: string): boolean {
  // A restricted session that lost vision must not request it again.
  const restriction = state.mode === "local" ? undefined : undefined
  return restriction === undefined ? false : false
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
  const order: Record<string, number> = { power: 3, cheap: 2, free: 1, local: 0 }
  const current = order[mode] ?? 1
  const cheaper = Object.keys(order).filter((m) => order[m] < current && order[m] > 0)
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

/** The default discovery source, reading from the plugin context. */
function defaultSource(ctx: EngineContext): DiscoverySource {
  return {
    async registry() {
      const result = await ctx.model.list()
      const data = (result as { data?: unknown }).data as
        | Array<{ providerID: string; id: string }>
        | undefined
      if (!Array.isArray(data)) return []
      return data.map((m) => ({ providerID: m.providerID, model: m }))
    },
    async local() {
      return []
    },
  }
}

export { appendLog }
