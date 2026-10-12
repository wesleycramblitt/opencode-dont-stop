/**
 * Shared durable state for dont-stop.
 *
 * This file is the bridge between the two halves of the plugin. The server
 * entrypoint (`index.ts`) owns the engine and writes state here on every
 * meaningful change; the terminal entrypoint (`tui.ts`) reads it to render
 * status. Only fields the terminal can legitimately initiate (mode, loop
 * start/stop) are reconciled back, which is why writes are atomic-ish and
 * always full-object: the reader never has to guess at partial state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const MODES = ["free", "cheap", "local", "power", "stop"] as const
export type Mode = (typeof MODES)[number]

/** One model slot. Mirrors `Model.Ref` with an optional variant. */
export interface ModelSlot {
  providerID: string
  id: string
  variant?: string
}

export interface LogEntry {
  t: number
  level: "info" | "warn" | "error"
  message: string
}

export interface LoopState {
  status: "active" | "stopped"
  sessionID: string | null
  prompt: string
  /** Loop iterations completed. */
  iterations: number
  startedAt: number | null
  lastResult: string | null
  /**
   * The instance (opencode process) allowed to drive this loop. A loop is a
   * live conversation with in-flight requests, so it cannot be picked up by
   * whoever reads the file next; only the instance that started it advances,
   * interrupts and rotates. An empty owner means nobody may drive it.
   */
  owner: string | null
  /** The owner's last heartbeat. A loop whose owner stopped beating is orphaned. */
  ownerBeatAt: number
  /** Model rotations bought since the last completed turn. */
  rotations: number
}

/**
 * A control request, separate from the status it affects.
 *
 * Everything else in this file is *reporting*: the engine writes what is true
 * and any writer may overwrite it. An intent is an *instruction*, so it must
 * survive being overwritten by a status write that raced it. That is what the
 * sequence number is for: writers merge intents by `seq` instead of last-write
 * wins, so a halt is never lost — and a writer that has already acted on a
 * sequence ignores the replay of its own request.
 */
export interface Intent {
  /** Monotonic across every writer. The highest `seq` is the newest word. */
  seq: number
  action: "none" | "start" | "halt"
  at: number
}

export interface Cooldowns {
  /** modelKey -> epoch ms after which the model may be tried again */
  [key: string]: number
}

export interface PluginState {
  version: number
  mode: Mode
  degraded: boolean
  preferredMode: Mode | null
  loop: LoopState
  /** The newest control instruction. Written by any half, applied by the owner. */
  intent: Intent
  /** The main session's model. */
  main: ModelSlot | null
  /** Per-agent-type model assignments, keyed by agent id. */
  agentModels: Record<string, ModelSlot>
  cooldowns: Cooldowns
  consecutiveErrors: number
  lastEvent: string | null
  log: LogEntry[]
  updated: number
}

/** Where handoff summaries are written, beside the state file. */
export function handoffDirectory(): string {
  return join(homedir(), ".config", "opencode", "dont-stop", "handoffs")
}

/**
 * The hard switch, honored by both halves with no restart.
 *
 * `DONT_STOP_DISABLED=1` (any value other than "" and "0") makes the server
 * half load inert — no engine, no watcher, no command surface — and the TUI
 * half render a plain "off" indicator instead of the live footer. Removing the
 * plugin from `plugins` in opencode.json still needs a service restart; this
 * is the switch that does not.
 */
export function dontStopDisabled(): boolean {
  const value = process.env.DONT_STOP_DISABLED
  return value !== undefined && value !== "" && value !== "0"
}

export function statePath(): string {
  return join(homedir(), ".config", "opencode", "dont-stop-state.json")
}

export function initialState(): PluginState {
  return {
    version: 1,
    mode: "free",
    degraded: false,
    preferredMode: null,
    loop: {
      status: "stopped",
      sessionID: null,
      prompt: "",
      iterations: 0,
      startedAt: null,
      lastResult: null,
      owner: null,
      ownerBeatAt: 0,
      rotations: 0,
    },
    intent: { seq: 0, action: "none", at: 0 },
    main: null,
    agentModels: {},
    cooldowns: {},
    consecutiveErrors: 0,
    lastEvent: null,
    log: [],
    updated: Date.now(),
  }
}

/** Read state, tolerating absence and corruption. Never throws. */
export function readState(): PluginState {
  const file = statePath()
  if (!existsSync(file)) return initialState()
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PluginState>
    return mergeState(initialState(), parsed)
  } catch {
    return initialState()
  }
}

/**
 * Merge a partial over the defaults. Arrays and nested objects are replaced,
 * not deep-merged, because a partial write should mean "this is the truth"
 * for the fields it names.
 */
function mergeState(base: PluginState, patch: Partial<PluginState>): PluginState {
  const next: PluginState = { ...base, ...patch }
  next.loop = { ...base.loop, ...(patch.loop ?? {}) }
  next.intent = { ...base.intent, ...(patch.intent ?? {}) }
  next.agentModels = { ...patch.agentModels }
  next.cooldowns = { ...patch.cooldowns }
  next.log = [...(patch.log ?? [])]
  return next
}

/**
 * Write state atomically: temp file, then rename. Never throws.
 *
 * Two things protect the file from its own readers:
 *
 * 1. **The control intent is merged, not copied.** A status write from this
 *    writer may not erase an intent someone else wrote in the meantime,
 *    because the intent is the only field that outlives a race — the TUI's
 *    halt must still be the newest word after a heartbeat rewrites everything
 *    else.
 * 2. **Identical content is not written at all.** This file is watched by
 *    the very watcher that drives this write: a persist on a watch tick
 *    rewrote the same content, the rename fired the watcher, and the watcher
 *    persisted again — a self-sustaining cycle that churned the TUI (palette
 *    and footer re-rendering many times a second). A write whose only
 *    difference is `updated` is not a change, so it is skipped. The file's
 *    mtime is therefore a true signal of change, which both the watcher and
 *    the TUI rely on.
 */
export function writeState(state: PluginState): void {
  try {
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    const existing = readRaw(file)
    const theirs = existing ? parsedIntent(existing) : undefined
    if (theirs && theirs.seq > state.intent.seq) state.intent = theirs
    if (existing !== null && stableEqual(state, existing)) return
    state.updated = Date.now()
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8")
    renameSync(tmp, file)
  } catch {
    // Best effort: a failed write must never take down the host.
  }
}

/** The intent a serialized state file carries, or undefined when it cannot be read. */
function parsedIntent(raw: string): Intent | undefined {
  try {
    return (JSON.parse(raw) as Partial<PluginState>).intent
  } catch {
    return undefined
  }
}

/** Raw file contents, or null when the file is absent or unreadable. */
function readRaw(file: string): string | null {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

/** Whether a serialized state differs from `state` anywhere but `updated`. */
function stableEqual(state: PluginState, raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Partial<PluginState>
    return JSON.stringify({ ...parsed, updated: 0 }) === JSON.stringify({ ...state, updated: 0 })
  } catch {
    return false
  }
}

/**
 * Issue the next control instruction. Reads the file first so a halt written
 * by another half raises the sequence above it rather than fighting it.
 */
export function bumpIntent(state: PluginState, action: Intent["action"]): Intent {
  const theirs = readState().intent
  state.intent = {
    seq: Math.max(theirs.seq, state.intent.seq) + 1,
    action,
    at: Date.now(),
  }
  return state.intent
}

/** Append a log line, keeping the tail bounded. Mutates `state.log`. */
export function appendLog(state: PluginState, level: LogEntry["level"], message: string): void {
  state.log.push({ t: Date.now(), level, message })
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200)
}
