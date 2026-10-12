/**
 * dont-stop — server entrypoint.
 *
 * Wires the engine to the opencode server context and owns everything that
 * must exist headlessly: the command API, the state-file watcher the TUI
 * writes through, and the event pump.
 *
 * The root-cause fix lives in `lib/apply.ts` and is exercised here: on every
 * meaningful change we push the plan through *both* channels, so a mode
 * switch reaches sessions that already pinned a model.
 */

import { watch } from "node:fs"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname } from "node:path"

import { LoopEngine } from "./lib/engine.ts"
import { createLogger } from "./lib/log.ts"
import { eventData, eventSignals, TURN_END_TYPES, type SessionEvent } from "./lib/events.ts"
import { catalogueRefreshDue, CATALOGUE_FILE, fetchCatalogue, writeCatalogue } from "./lib/fetch.ts"
import {
  MODES,
  dontStopDisabled,
  readState,
  statePath,
  writeState,
  type Mode,
  type PluginState,
} from "./lib/state.ts"
import { exportSummary } from "./lib/catalogue.ts"
import { describeMode } from "./lib/modes.ts"
import { DEFAULT_CLOCKS } from "./lib/clocks.ts"

/* -------------------------------------------------------------------- types */

/** Where a prompt file may live, resolved against the cwd. */
function resolvePromptFile(path: string): string {
  const home = process.env.HOME ?? ""
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`
  return path
}

/** Read a prompt from a file. Throws a descriptive error on failure. */
function readPromptFile(path: string): string {
  const resolved = resolvePromptFile(path)
  if (!existsSync(resolved)) {
    throw new Error(`prompt file not found: ${resolved}`)
  }
  const text = readFileSync(resolved, "utf8")
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new Error(`prompt file is empty: ${resolved}`)
  }
  return trimmed
}

export default {
  id: "dont-stop",

  async setup(ctx: unknown) {
    const context = ctx as PluginServerContext

    // The hard switch (lib/state.ts dontStopDisabled): with the plugin still
    // registered, an inert load means nothing is applied — no engine, no
    // watcher, no command surface — so no session's model can move. It is
    // honored without a restart, which removing the plugin from `plugins`
    // cannot be.
    if (dontStopDisabled()) {
      console.log("[dont-stop] disabled (DONT_STOP_DISABLED); loading inert")
      return () => {}
    }

    const state: PluginState = readState()
    const log = createLogger(state)

    const persist = () => writeState(state)

    const engine = new LoopEngine(
      context as unknown as ConstructorParameters<typeof LoopEngine>[0],
      state,
      log,
      {
        clocks: DEFAULT_CLOCKS,
        onStateChange: persist,
      },
    )

    /* ------------------------------------------------------------ command */

    await context.command.transform((editor) => {
      editor.add({
        name: "dont-stop-set",
        description:
          "Control dont-stop: status, mode free|cheap|local|power, start <prompt | --prompt-file PATH>, stop, probe, best-for <agent>, update-model-catalogue",
        execute: async (input: { prompt?: string | { text?: string }; sessionID?: string }) => {
          const raw =
            typeof input?.prompt === "string" ? input.prompt : input?.prompt?.text ?? ""
          return runCommand(String(raw), {
            state,
            engine,
            log,
            persist,
            sessionID: input?.sessionID,
          })
        },
      })
    })

    /* ------------------------------------------------------------- events */

    const abort = new AbortController()
    let iterator: AsyncIterator<SessionEvent> | undefined

    const consumer = (async () => {
      try {
        const subscription = context.event.subscribe({ signal: abort.signal })
        iterator = subscription[Symbol.asyncIterator]()
        for (;;) {
          const next = await iterator.next()
          if (next.done) break
          const event = next.value as SessionEvent
          engine.observe(event)

          // A failed request is the recovery funnel. v2 reports failures as
          // `session.error` (provider errors) and on `session.execution.failed`
          // (a turn that ended in failure); both carry the same error shape.
          if (event.type === "session.error" || event.type === "session.execution.failed") {
            const signals = eventSignals(event)
            if (signals.sessionID) {
              await engine.onError({
                sessionID: signals.sessionID,
                agent: signals.agent ?? undefined,
                message: signals.error?.message,
                status: signals.error?.status,
                type: signals.error?.type,
              })
            }
          }

          // A turn of the loop's session ended — this is the loop's driver.
          // The event names the ending, so a subagent ending its own turn, or
          // an ending in an instance that is not driving the loop, cannot
          // touch the counter. `onTurnEnd` also stands down after the hang
          // path's own interrupts, so the scheduled re-drive owns those.
          if (TURN_END_TYPES.has(event.type)) {
            const sid = eventData(event).sessionID
            if (typeof sid === "string" && sid === state.loop.sessionID) {
              await engine.onTurnEnd(sid, event.type)
              persist()
            }
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          log.warn(`event consumer stopped: ${messageOf(error)}`)
        }
      }
    })()

    /* ------------------------------------------------------- state file watch */

    // The TUI writes this file to request a mode change or a halt. Only the
    // fields it can legitimately initiate are reconciled; the engine's own
    // writes already describe the engine and are ignored. Loop control rides
    // on the sequenced intent rather than the status fields, so a request
    // cannot be lost to a status write that happened to land after it.
    let settle: ReturnType<typeof setTimeout> | undefined
    const watcher = watch(dirname(statePath()), (_event, filename) => {
      if (filename && basename(filename) !== basename(statePath())) return
      clearTimeout(settle)
      settle = setTimeout(() => {
        void reconcileFromFile()
      }, 150)
    })

    async function reconcileFromFile(): Promise<void> {
      const incoming = readState()

      if (incoming.mode !== state.mode) {
        const mode = MODES.includes(incoming.mode) ? incoming.mode : state.mode
        log.info(`mode changed externally to ${mode}`)
        await engine.setMode(mode)
        persist()
      }

      // Loop control no longer comes from the status fields — those are the
      // engine's report and were being overwritten by whichever writer ran
      // last, which is how a halt could be lost within a heartbeat. It comes
      // from the intent, which is merged by sequence number and therefore
      // survives the race.
      await engine.applyIntent()
      persist()
    }

    /* ------------------------------------------------------------- startup */

    log.info(
      `dont-stop starting in ${state.mode} mode (${describeMode(state.mode)}) as instance ${engine.instanceID}`,
    )

    // Agents from agents/*.md are not in the registry when a transform first
    // registers, so replay the transform once they have loaded.
    const timers = [500, 2000, 5000].map((delay) =>
      setTimeout(() => {
        void context.agent.reload().catch(() => {})
      }, delay),
    )

    // The model registry is likewise still settling while setup runs, so the
    // reachability read `discover()` took can be missing providers that load
    // moments later. Re-derive until it settles; each pass is an in-process
    // read that logs only when the counts move.
    for (const delay of [500, 2000, 5000, 15000]) {
      setTimeout(() => {
        void engine.recheckReachability().catch(() => {})
      }, delay)
    }

    // Discovery must not hold up startup; the engine applies the plan the
    // moment it lands.
    const heartbeat = setInterval(() => {
      void maybeRefreshCatalogue().catch((error) => log.warn(`catalogue refresh failed: ${messageOf(error)}`))
      void engine.beat().catch((error) => log.warn(`heartbeat failed: ${messageOf(error)}`))
    }, DEFAULT_CLOCKS.intervalMs)

    // The catalogue refreshes itself on a cadence (owner, 2026-10-12): a stale
    // file is rebuilt from the live sources, reloaded into the engine, and the
    // plan re-applied — so new free rows, price changes and retirements reach
    // the loop without a manual command. The file's mtime is the clock, a
    // failed fetch keeps the current catalogue, and one fetch at a time.
    let catalogueFetching = false
    const refreshHours = Number(process.env.DONT_STOP_CATALOGUE_REFRESH_HOURS)
    const refreshIntervalMs = Number.isFinite(refreshHours) && refreshHours > 0
      ? refreshHours * 60 * 60 * 1000
      : undefined
    async function maybeRefreshCatalogue(): Promise<void> {
      if (catalogueFetching) return
      if (!catalogueRefreshDue(CATALOGUE_FILE, Date.now(), refreshIntervalMs)) return
      catalogueFetching = true
      try {
        log.info("catalogue is stale; refreshing automatically")
        const document = await fetchCatalogue()
        writeCatalogue(document)
        await engine.discover()
        await engine.refresh(true)
        log.info("automatic catalogue refresh applied")
        persist()
      } catch (error) {
        // A failed refresh keeps the file it failed to replace: the loop
        // plans against the old catalogue, which is stale but working.
        log.warn(`automatic catalogue refresh failed: ${messageOf(error)}; keeping the current catalogue`)
      } finally {
        catalogueFetching = false
      }
    }

    void engine
      .discover()
      // A loop left active in the state file belongs to an instance that is
      // gone. It is halted here rather than resumed: a loop is a live
      // conversation in another process, and this one never started it.
      .then(() => engine.reapOrphanedLoop())
      .then(() => engine.refresh(true))
      .catch((error) => log.warn(`startup discovery failed: ${messageOf(error)}`))

    return () => {
      abort.abort()
      watcher.close()
      clearTimeout(settle)
      clearInterval(heartbeat)
      for (const timer of timers) clearTimeout(timer)
      void engine.stop("plugin unloaded")
      persist()
      const termination = Promise.allSettled([consumer, iterator?.return?.()])
      void Promise.race([termination, new Promise((resolve) => setTimeout(resolve, 2000))])
    }
  },
}

/* ----------------------------------------------------------------- commands */

/** The mode names a user can select, `stop` excluded: halting is a verb. */
const MODE_NAMES = MODES.filter((m) => m !== "stop")

interface CommandEnv {
  state: PluginState
  engine: LoopEngine
  log: ReturnType<typeof createLogger>
  persist: () => void
  sessionID?: string
}

/**
 * The headless command surface. Kept as a plain function so it can be tested
 * without a live server, and so the TUI can call the same verbs.
 */
export function runCommand(raw: string, env: CommandEnv): string {
  const { state, engine, log, persist, sessionID } = env
  const [verb, ...rest] = raw.trim().split(/\s+/)

  if (!verb || verb === "status" || verb === "help") {
    return formatStatus(state, engine)
  }

  // `mode <name>` and a bare mode name both work. `stop` is a mode in the
  // state machine but a verb here, so it is handled before the mode branch
  // and never reaches it.
  let modeName: string | undefined
  if (verb === "mode" && rest.length > 0) modeName = rest[0].toLowerCase()
  else if ((MODES as readonly string[]).includes(verb) && verb !== "stop") modeName = verb

  if (modeName) {
    void engine.setMode(modeName as Mode).then(persist)
    return `mode set to ${modeName} — ${describeMode(modeName as Mode)}`
  }

  if (verb === "start") {
    // `--prompt-file PATH` reads the prompt from disk; anything else is the
    // prompt itself. The flag may appear anywhere in the arguments.
    const fileIndex = rest.findIndex((arg) => arg === "--prompt-file")
    if (fileIndex !== -1) {
      const path = rest[fileIndex + 1]
      if (!path) return "usage: dont-stop-set start --prompt-file <path>"
      let prompt: string
      try {
        prompt = readPromptFile(path)
      } catch (error) {
        return `error: ${messageOf(error)}`
      }
      rest.splice(fileIndex, 2)
      const inline = rest.join(" ").trim()
      if (inline) prompt = `${inline}\n\n${prompt}`
      const target = sessionID ?? newestTrackedFor(engine)
      if (!target) return "error: no session to run the loop on"
      void engine.start(target, prompt).then(persist)
      return `loop started from ${path} on ${target} (mode: ${state.mode})`
    }

    const prompt = rest.join(" ").trim()
    if (!prompt) return "usage: dont-stop-set start <prompt> | start --prompt-file <path>"
    const target = sessionID ?? newestTrackedFor(engine)
    if (!target) return "error: no session to run the loop on"
    void engine.start(target, prompt).then(persist)
    return `loop started on ${target} (mode: ${state.mode})`
  }

  if (verb === "stop") {
    void engine.stop(rest.join(" ").trim() || "stopped by command").then(persist)
    return "halting the loop: its in-flight turn is cancelled and every instance stops driving it"
  }

  if (verb === "probe" || verb === "discover") {
    const catalogue = engine.model
    if (!catalogue) return "catalogue not built yet; try again shortly"
    return exportSummary(catalogue)
  }

  if (verb === "best-for") {
    const agent = rest[0]?.toLowerCase() || "general"
    const catalogue = engine.model
    if (!catalogue) return "catalogue not built yet; try again shortly"
    const ranked = engine.buildPlan()
    const slot = ranked.agents[agent] ?? ranked.main
    if (!slot) return `no model assigned for ${agent}`
    return `${agent}: ${slot.providerID}/${slot.id}`
  }

  if (verb === "update-model-catalogue" || verb === "update-catalogue" || verb === "catalogue-update") {
    // Rebuilds the catalogue from the live sources (models.dev, the local
    // ollama daemon, and — when a key is configured — Alibaba's own
    // inventory), writes data/catalogue.json, then reloads it and re-plans.
    // Network-bound on purpose: it is an explicit command, not a heartbeat.
    void (async () => {
      try {
        const document = await fetchCatalogue()
        writeCatalogue(document)
        log.info(`catalogue rebuilt: ${document.models.length} models`)
        persist()
        await engine.discover()
        await engine.refresh(true)
        persist()
      } catch (error) {
        log.error(`catalogue update failed: ${messageOf(error)}`)
      }
    })()
    return "catalogue rebuild started: fetching live sources into data/catalogue.json"
  }

  if (verb === "track") {
    const target = rest[0] ?? sessionID
    if (!target) return "usage: dont-stop-set track <sessionID>"
    engine.track(target)
    return `tracking ${target}`
  }

  return [
    `unknown verb: ${verb}`,
    `try: status · mode ${MODE_NAMES.join("|")} · start <prompt | --prompt-file PATH> · stop · probe · best-for <agent> · update-model-catalogue`,
  ].join("\n")
}

function formatStatus(state: PluginState, engine: LoopEngine): string {
  const lines = [
    `dont-stop — mode ${state.mode}${state.degraded ? ` (degraded from ${state.preferredMode})` : ""}`,
    `  ${describeMode(state.mode)}`,
    `  loop: ${state.loop.status}${state.loop.sessionID ? ` on ${state.loop.sessionID}` : ""}${state.loop.owner ? ` (owner ${state.loop.owner})` : ""}`,
    `  iterations: ${state.loop.iterations}`,
  ]
  if (state.loop.rotations > 0) {
    lines.push(`  rotations without a completed turn: ${state.loop.rotations}`)
  }
  if (state.intent && state.intent.action !== "none") {
    lines.push(`  intent: ${state.intent.action} #${state.intent.seq}`)
  }
  if (state.loop.prompt) lines.push(`  prompt: ${truncate(state.loop.prompt, 60)}`)
  if (state.loop.lastResult) lines.push(`  last: ${state.loop.lastResult}`)
  if (state.main) lines.push(`  main model: ${state.main.providerID}/${state.main.id}`)

  const agents = Object.entries(state.agentModels)
  if (agents.length > 0) {
    lines.push("  agents:")
    for (const [agent, slot] of agents) {
      lines.push(`    ${agent}: ${slot.providerID}/${slot.id}`)
    }
  }

  const cooldowns = Object.entries(state.cooldowns).filter(([, until]) => until > Date.now())
  if (cooldowns.length > 0) {
    lines.push(`  cooling: ${cooldowns.map(([key]) => key).join(", ")}`)
  }

  const catalogue = engine.model
  if (catalogue) {
    lines.push(`  catalogue: ${catalogue.models.length} models`)
  }

  const errors = state.log.filter((entry) => entry.level === "error" || entry.level === "warn").slice(-3)
  if (errors.length > 0) {
    lines.push("  recent:")
    for (const entry of errors) lines.push(`    [${entry.level}] ${entry.message}`)
  }

  return lines.join("\n")
}

function newestTrackedFor(engine: LoopEngine): string | null {
  let newest: string | null = null
  let at = 0
  for (const record of engine.trackedSessions()) {
    if (record.lastSeen > at) {
      at = record.lastSeen
      newest = record.sessionID
    }
  }
  return newest
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------- types */

interface AgentEditor {
  list(): Array<{ id: string; model?: unknown }>
  update(id: string, update: (agent: { model?: unknown }) => void): void
}

interface PluginServerContext {
  command: { transform(fn: (editor: { add(input: { name: string; description: string; execute: (input: { prompt?: string | { text?: string }; sessionID?: string }) => Promise<string> | string }): void }) => void): Promise<unknown> }
  agent: { reload(): Promise<unknown> }
  /** v2 events: `{ type, data }`. */
  event: { subscribe(input: { signal: AbortSignal }): AsyncIterable<SessionEvent> }
  model: { list(): Promise<{ data?: unknown }> }
}
