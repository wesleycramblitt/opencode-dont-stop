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
import {
  MODES,
  readState,
  statePath,
  writeState,
  type Mode,
  type PluginState,
} from "./lib/state.ts"
import { exportSummary } from "./lib/catalogue.ts"
import { describeMode } from "./lib/modes.ts"
import { DEFAULT_CLOCKS } from "./lib/clocks.ts"

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
    let iterator: AsyncIterator<{ type: string; properties?: Record<string, unknown> }> | undefined

    const consumer = (async () => {
      try {
        const subscription = context.event.subscribe({ signal: abort.signal })
        iterator = subscription[Symbol.asyncIterator]()
        for (;;) {
          const next = await iterator.next()
          if (next.done) break
          engine.observe(next.value)
          const event = next.value
          if (event.type === "session.error" || event.type === "message.error") {
            const props = event.properties as
              | { info?: { id?: string }; sessionID?: string; error?: { message?: string; status?: number; type?: string }; agent?: string }
              | undefined
            await engine.onError({
              sessionID: props?.sessionID ?? props?.info?.id,
              agent: props?.agent,
              message: props?.error?.message,
              status: props?.error?.status,
              type: props?.error?.type,
            })
          } else if (event.type === "session.idle") {
            // The session finished a turn. When this is the loop's own session
            // this is the point where it continues rather than ends.
            // `advance` counts the iteration itself, and it ignores anything
            // that is not the loop it owns — a subagent going idle, or an idle
            // event in an instance that is not driving the loop, must not
            // touch the counter.
            const sid = (event.properties?.info as { id?: string } | undefined)?.id
              ?? (event.properties?.sessionID as string | undefined)
              ?? state.loop.sessionID
            if (sid !== null && sid === state.loop.sessionID) {
              await engine.advance(sid)
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

    // Discovery must not hold up startup; the engine applies the plan the
    // moment it lands.
    const heartbeat = setInterval(() => {
      void engine.beat().catch((error) => log.warn(`heartbeat failed: ${messageOf(error)}`))
    }, DEFAULT_CLOCKS.intervalMs)

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
    void engine
      .refreshCatalogue()
      .then(() => {
        persist()
        return engine.refresh(true)
      })
      .then(persist)
      .catch((error: unknown) => log.error(`catalogue update failed: ${messageOf(error)}`))
    return "model catalogue refresh started; it writes data/catalogue.json"
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
  event: { subscribe(input: { signal: AbortSignal }): AsyncIterable<{ type: string; properties?: Record<string, unknown> }> }
  model: { list(): Promise<{ data?: unknown }> }
}
