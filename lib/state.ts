/**
 * dont-stop — Shared durable state for the loop plugin.
 *
 * This file is the bridge between the server half (index.ts) and the terminal
 * half (tui.tsx). The server owns the engine and writes state here on every
 * meaningful change; the terminal reads it to render status. Only loop fields
 * live here now — modes were removed entirely (owned exclusively by the
 * sibling model-selector plugin); model selection, ranking, cooldowns, funds
 * tracking also live there, which owns that contract.
 *
 * Fields the terminal can legitimately initiate (loop start/stop via intent)
 * are reconciled back, which is why writes are atomic-ish and always full-object:
 * the reader never has to guess at partial state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface LogEntry {
  t: number
  level: "info" | "warn" | "error"
  message: string
}

/**
 * State of one loop iteration record. The loop runs in a single session,
 * records its progress, and survives across restarts through this file.
 */
export interface LoopState {
  status: "active" | "stopped"
  /** The session this loop drives. Null when the loop has not started yet. */
  sessionID: string | null
  /**
   * Kept for backwards compatibility; always 1 since we no longer rotate sessions.
   * Session rotation is handled by model-selector's own logic.
   */
  sessionNumber: number
  prompt: string
  /** Loop iterations completed. */
  iterations: number
  /**
   * Turns completed in the CURRENT session.
   *
   * The loop's identity is the work and `iterations` counts all of it, but a
   * session is retired after a budget of turns — a long conversation degrades
   * the model at the work — so the freshness metric is per session and resets
   * when the loop rotates.
   */
  sessionIterations: number
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
  /** Consecutive errors this loop's session survived (reported, never fatal). */
  consecutiveErrors: number
  /**
   * When the loop's in-flight turn started (epoch ms), or null when the loop
   * is between turns. Set when a prompt is sent, cleared when its turn ends.
   */
  turnStartedAt: number | null
}

/** One loop per session, keyed by session id. */
export interface Loops {
  [sessionID: string]: LoopState
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

/**
 * Path to the don't stop state JSON file. Lives under ~/.config/opencode
 * alongside opencode.json so the operator can find it easily.
 */
export function statePath(): string {
  return join(homedir(), ".config", "opencode", "dont-stop-state.json")
}

export function initialState(): PluginState {
  return {
    version: 1,
    loops: {},
    intent: { seq: 0, action: "none", at: 0 },
    log: [],
    updated: Date.now(),
  }
}

/** One loop, from the pieces the rest of the file can carry. */
function loopState(): LoopState {
  return {
    status: "stopped",
    sessionID: null,
    sessionNumber: 1,
    prompt: "",
    iterations: 0,
    sessionIterations: 0,
    startedAt: null,
    lastResult: null,
    owner: null,
    ownerBeatAt: 0,
    rotations: 0,
    consecutiveErrors: 0,
    turnStartedAt: null,
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
 *
 * One migration rides along: files written by a pre-per-session plugin carry
 * a single `loop` instead of the `loops` map. It is folded into a per-session
 * entry when the map is empty, so the loop that was running survives the
 * upgrade.
 *
 * Stale keys from the removed modes concept (a top-level `mode`, per-loop
 * `mode`/`degraded`/`preferredMode`, a `"mode"` intent action with its `mode`
 * field) are tolerated and dropped, so the next persist cleans the file.
 */
function mergeState(base: PluginState, patch: Partial<PluginState>): PluginState {
  const { mode: _droppedTopMode, ...modeFreePatch } = patch as Partial<PluginState> & { mode?: unknown }
  const next: PluginState = { ...base, ...modeFreePatch }
  delete (next as unknown as Record<string, unknown>).mode
  next.loops = { ...(modeFreePatch.loops ?? {}) }
  // Normalize per-session rows: files written before a field existed carry
  // only the pieces their writer knew, so each row is completed over the
  // factory default. Stale mode keys ride along in old rows and are stripped.
  for (const [sessionID, row] of Object.entries(next.loops)) {
    if (row) {
      const { mode: _m, degraded: _d, preferredMode: _p, ...modelessRow } = row as LoopState & {
        mode?: unknown
        degraded?: unknown
        preferredMode?: unknown
      }
      next.loops[sessionID] = { ...loopState(), ...modelessRow }
    }
  }
  if (Object.keys(next.loops).length === 0) {
    // The pre-per-session file carried a single `loop` plus global
    // consecutiveErrors; that shape is not in the type anymore, so the read
    // is typed loosely on purpose. Stale mode keys that may ride along are
    // stripped.
    const legacyPatch = patch as unknown as {
      loop?: Partial<LoopState> & { mode?: unknown; degraded?: unknown; preferredMode?: unknown }
      degraded?: boolean
      preferredMode?: unknown
      consecutiveErrors?: number
    }
    const legacy = legacyPatch.loop
    if (legacy && typeof legacy.sessionID === "string" && legacy.sessionID !== "") {
      const { mode: _m, degraded: _d, preferredMode: _p, ...modelessLegacy } = legacy
      next.loops[legacy.sessionID] = {
        ...loopState(),
        ...modelessLegacy,
        consecutiveErrors: legacy.consecutiveErrors ?? legacyPatch.consecutiveErrors ?? 0,
      }
    }
  }
  const nextIntent = { ...base.intent, ...(patch.intent ?? {}) }
  if ((nextIntent.action as string) === "mode") nextIntent.action = "none"
  delete (nextIntent as Record<string, unknown>).mode
  next.intent = nextIntent
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
export function writeState(state: PluginState, ownInstanceID?: string): void {
  try {
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    const existing = readRaw(file)
    const parsedExisting: Partial<PluginState> | null = existing
      ? safeParse(existing)
      : null
    const theirs = parsedExisting?.intent
    if (theirs && theirs.seq > state.intent.seq) {
      state.intent = theirs
    }
    // Merge the loops map from disk so a stale in-memory snapshot cannot
    // erase a row written by another instance. An instance may write (and
    // possibly remove) only the rows it owns; everything else is adopted.
    if (parsedExisting?.loops && typeof parsedExisting.loops === "object") {
      for (const [sid, diskRow] of Object.entries(parsedExisting.loops)) {
        const local = state.loops[sid]
        if (!local) {
          state.loops[sid] = diskRow
          continue
        }
        // An instance only keeps authority for rows it owns. A row it does
        // not own always defers to what is on disk, so a stale instance never
        // clobbers the owner's progress.
        if (local.owner === ownInstanceID) {
          if ((diskRow.ownerBeatAt ?? 0) > (local.ownerBeatAt ?? 0)) {
            state.loops[sid] = diskRow
          }
        } else {
          state.loops[sid] = diskRow
        }
      }
    }
    // Never shrink the surfaced log: if disk has more, take it.
    if (parsedExisting?.log && Array.isArray(parsedExisting.log) && parsedExisting.log.length > state.log.length) {
      state.log = [...parsedExisting.log]
    }

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
/** Read a parsed Partial<PluginState>, or null when the file is incoherent. */
function safeParse(raw: string): Partial<PluginState> | null {
  try { return JSON.parse(raw) as Partial<PluginState> } catch { return null }
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

/* -------------------------------------------------------------------- types */

export interface PluginState {
  version: number
  loops: Loops
  /** The newest control instruction. Written by any half, applied by the owner. */
  intent: Intent
  log: LogEntry[]
  updated: number
}
