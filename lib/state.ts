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
  /** The main session's model. */
  main: ModelSlot | null
  /** Per-agent-type model assignments, keyed by agent id. */
  agentModels: Record<string, ModelSlot>
  /** Rotation cursor per (agent, chain) so fallback walks the chain. */
  rotation: Record<string, number>
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
    },
    main: null,
    agentModels: {},
    rotation: {},
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
  next.agentModels = { ...patch.agentModels }
  next.rotation = { ...patch.rotation }
  next.cooldowns = { ...patch.cooldowns }
  next.log = [...(patch.log ?? [])]
  return next
}

/** Write state atomically: temp file, then rename. Never throws. */
export function writeState(state: PluginState): void {
  try {
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    state.updated = Date.now()
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8")
    renameSync(tmp, file)
  } catch {
    // Best effort: a failed write must never take down the host.
  }
}

/** Append a log line, keeping the tail bounded. Mutates `state.log`. */
export function appendLog(state: PluginState, level: LogEntry["level"], message: string): void {
  state.log.push({ t: Date.now(), level, message })
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200)
}
