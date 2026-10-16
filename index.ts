/**
 * dont-stop — server entrypoint.
 *
 * Wires the loop engine to the opencode server context and owns everything that
 * must exist headlessly: the command API, the state-file watcher the TUI
 * writes through, and the event pump.
 *
 * Model selection, modes, ranking, cooldowns, funds tracking — all moved to
 * the sibling model-selector plugin. This plugin's only job is the loop:
 * reinjecting prompts, managing sessions, recovering from hangs and restarts.
 */

import { watch } from "node:fs"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import { LoopEngine } from "./lib/engine.ts"
import { createLogger } from "./lib/log.ts"
import { eventData, eventSignals, TURN_END_TYPES, type SessionEvent } from "./lib/events.ts"
import {
  dontStopDisabled,
  readState,
  statePath,
  writeState,
  type PluginState,
} from "./lib/state.ts"
import { loadDefaultPrompt } from "./lib/default-prompt.ts"
import { DEFAULT_CLOCKS } from "./lib/clocks.ts"

/* -------------------------------------------------------------------- types */

/**
 * Where a prompt file may live.
 *
 * A relative path resolves against the location the command was run in — the
 * directory the user sees in the TUI — not the server's process cwd: the
 * plugin runs in the shared server, whose cwd is wherever the service was
 * launched. That mismatch made `--prompt-file prompts/loop.md` look under
 * `/home/wes` instead of the project, fail to find the file, and leave the
 * palette with nothing to show, because a command's return value is discarded
 * in v2. `process.cwd()` remains the last resort when the runtime exposes no
 * location.
 */
function resolvePromptFile(path: string, baseDir?: string): string {
  const home = process.env.HOME ?? ""
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`
  if (!path.startsWith("/") && !path.startsWith("~")) {
    return resolve(baseDir ?? process.cwd(), path)
  }
  return path
}

/** Read a prompt from a file. Throws a descriptive error on failure. */
function readPromptFile(path: string, baseDir?: string): string {
  const resolved = resolvePromptFile(path, baseDir)
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

// Actually let me just do this right with proper ESM imports
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

    // `ownInstanceID` resolves lazily so the closure can be handed to the
    // engine's constructor (which creates the instance id) before persist runs.
    const persist = () => writeState(state, engine?.instanceID)
    let engine!: LoopEngine
    engine = new LoopEngine(
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
          "Control dont-stop: status, start <prompt | --prompt-file PATH>, stop, track",
        execute: async (input: { prompt?: string | { text?: string }; sessionID?: string }) => {
          const raw =
            typeof input?.prompt === "string" ? input.prompt : input?.prompt?.text ?? ""
          return runCommand(String(raw), {
            state,
            engine,
            log,
            persist,
            sessionID: input?.sessionID,
            baseDir: context.location?.directory,
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

          // A turn of a loop's session ended — this is the loop's driver.
          // Only the `session.execution.*` trio drives the loop. Per-session
          // since 2026-10-12: the engine decides which loop (if any) this
          // session's ending belongs to.
          if (TURN_END_TYPES.has(event.type)) {
            const sid = eventData(event).sessionID
            if (typeof sid === "string" && engine.loopFor(sid)) {
              await engine.onTurnEnd(sid, event.type)
              persist()
            }
          }

          // Handle stale reasoning-state errors locally. Full error
          // classification is owned by model-selector/lib/errors.ts, but
          // we detect the common shape here and compact+re-drive.
          if (event.type === "session.error") {
            const signals = eventSignals(event)
            if (typeof signals.sessionID === "string") {
              await engine.onError({ sessionID: signals.sessionID, agent: signals.agent ?? undefined, message: signals.error?.message })
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

    // The TUI writes this file to request a halt. Only the fields it can
    // legitimately initiate are reconciled; the engine's own writes already
    // describe the engine and are ignored. Loop control rides
    // on the sequenced intent rather than the status fields, so a request
    // cannot be lost to a status write that happened to land after it.
    let settle: ReturnType<typeof setTimeout> | undefined
    let watcher: ReturnType<typeof watch> | undefined
    try {
      watcher = watch(dirname(statePath()), (_event, filename) => {
        if (filename && basename(filename) !== basename(statePath())) return
        clearTimeout(settle)
        settle = setTimeout(() => {
          void reconcileFromFile().catch(() => {})
        }, 150)
      })
    } catch (error) {
      log.warn(
        `not watching ${dirname(statePath())}: ${messageOf(error)}; halt requests from the file need a restart`,
      )
    }

    async function reconcileFromFile(): Promise<void> {
      const incoming = readState()
      let changed = false

      // Loop control via intent: apply intents the engine hasn't seen yet.
      if (await engine.applyIntent(incoming)) changed = true

      if (changed) persist()
    }

    /* ------------------------------------------------------------- startup */

    log.info(
      `dont-stop starting as instance ${engine.instanceID}`,
    )

    // Start recovery on boot — adopt orphaned loops, re-seed restarted sessions.
    void engine
      .recoverOrphanedLoops()
      .catch((error) => log.warn(`startup recovery failed: ${messageOf(error)}`))

    const heartbeat = setInterval(() => {
      void engine.beat().catch((error) => log.warn(`heartbeat failed: ${messageOf(error)}`))
    }, DEFAULT_CLOCKS.intervalMs)

    const setupAt = Date.now()

    const teardown = () => {
      abort.abort()
      watcher?.close()
      clearTimeout(settle)
      clearInterval(heartbeat)
      const ownedActive = engine.ownedActiveSessions()
      // A genuine long-running instance (uptime > 30s) tears down its loops.
      // A load that dies within the boot window is almost always a hot reload
      // of this plugin, not a real shutdown - and stopping the loops there
      // kills a perfectly good running loop on every edit. Leave the loops on
      // disk for the next instance to adopt (recoverOrphanedLoops handles the
      // truly-dead case after the grace window expires).
      if (ownedActive.length > 0 && Date.now() - setupAt > 30_000) {
        void engine.stop("plugin unloaded").finally(() => {
          persist()
        })
      } else {
        persist()
      }
      const termination = Promise.allSettled([consumer, iterator?.return?.()])
      void Promise.race([termination, new Promise((resolve) => setTimeout(resolve, 2000))])
    }

    return teardown
  },
}

/* ----------------------------------------------------------------- commands */

interface CommandEnv {
  state: PluginState
  engine: LoopEngine
  log: ReturnType<typeof createLogger>
  persist: () => void
  sessionID?: string
  /** The location the command was run in; the base for relative prompt files. */
  baseDir?: string
}

/**
 * The headless command surface. Kept as a plain function so it can be tested
 * without a live server, and so the TUI can call the same verbs.
 */
export function runCommand(raw: string, env: CommandEnv): string {
  const { state, engine, log, persist, sessionID, baseDir } = env
  const [verb, ...rest] = raw.trim().split(/\s+/)

  if (!verb || verb === "status" || verb === "help") {
    return formatStatus(state)
  }

  if (verb === "start") {
    // `--prompt-file PATH` reads the prompt from disk; anything else is the
    // prompt itself. The flag may appear anywhere in the arguments.
    const fileIndex = rest.findIndex((arg) => arg === "--prompt-file")
    if (fileIndex !== -1) {
      const filePath = rest[fileIndex + 1]
      if (!filePath) return "usage: dont-stop-set start --prompt-file <path>"
      let prompt: string
      try {
        prompt = readPromptFile(filePath, baseDir)
      } catch (error) {
        log.warn(`start --prompt-file failed: ${messageOf(error)}`)
        persist()
        return `error: ${messageOf(error)}`
      }
      rest.splice(fileIndex, 2)
      const inline = rest.join(" ").trim()
      if (inline) prompt = `${inline}\n\n${prompt}`
      const target = sessionID ?? newestTrackedFor(engine)
      if (!target) return "error: no session to run the loop on"
      void engine.start(target, prompt).then(persist)
      return `loop started from ${filePath} on ${target}`
    }

    const target = sessionID ?? newestTrackedFor(engine)
    if (!target) return "error: no session to run the loop on"
    const prompt = rest.join(" ").trim()
    if (prompt) {
      void engine.start(target, prompt).then(persist)
      return `loop started on ${target}`
    }
    const prior = engine.primaryLoop()
    if (prior?.prompt) {
      void engine.start(target, prior.prompt).then(persist)
      return `loop restarted on ${target} with the stored prompt`
    }
    const fallback = loadDefaultPrompt(baseDir)
    void engine.start(target, fallback).then(persist)
    return `loop started on ${target} using the default prompt`
  }

  if (verb === "stop") {
    const target = rest[0] && rest[0].startsWith("ses") ? rest[0] : undefined
    void engine.stop("stopped by command", target).then(persist)
    return target
      ? `halting the loop on ${target}: its in-flight turn is cancelled`
      : "halting every loop: in-flight turns are cancelled and every instance stops driving them"
  }

  if (verb === "track") {
    const target = rest[0] ?? sessionID
    if (!target) return "usage: dont-stop-set track <sessionID>"
    engine.track(target)
    return `tracking ${target}`
  }

  return [
    `unknown verb: ${verb}`,
    `try: status · start <prompt | --prompt-file PATH> · stop · track`,
  ].join("\n")
}

function formatStatus(state: PluginState): string {
  const loops = Object.values(state.loops)
  const lines = [`dont-stop`]
  if (loops.length === 0) {
    lines.push("  loops: none")
  } else {
    for (const loop of loops) {
      lines.push(
        `  loop: ${loop.status}${loop.sessionID ? ` on ${loop.sessionID}` : ""}${loop.owner ? ` (owner ${loop.owner})` : ""}`,
      )
      lines.push(`    iterations: ${loop.iterations}`)
      lines.push(`    session turns: ${loop.sessionIterations}`)
      if (loop.turnStartedAt && loop.status === "active") {
        lines.push(`    in flight: turn working since ${new Date(loop.turnStartedAt).toLocaleTimeString()}`)
      }
      if (loop.rotations > 0) {
        lines.push(`    rotations: ${loop.rotations}`)
      }
      if (loop.prompt) lines.push(`    prompt: ${truncate(loop.prompt, 60)}`)
      if (loop.lastResult) lines.push(`    last: ${loop.lastResult}`)
    }
  }
  if (state.intent && state.intent.action !== "none") {
    lines.push(`  intent: ${state.intent.action} #${state.intent.seq}`)
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

interface PluginServerContext {
  /** The location this plugin instance is loaded for; the user's working directory. */
  location?: { directory?: string }
  command: { transform(fn: (editor: { add(input: { name: string; description: string; execute: (input: { prompt?: string | { text?: string }; sessionID?: string }) => Promise<string> | string }): void }) => void): Promise<unknown> }
  agent: { reload(): Promise<unknown> }
  /** v2 events: `{ type, data }`. */
  event: { subscribe(input: { signal: AbortSignal }): AsyncIterable<SessionEvent> }
  model: { list(): Promise<{ data?: unknown }> }
}
