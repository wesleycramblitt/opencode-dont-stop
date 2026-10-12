/**
 * dont-stop — Context handoff.
 *
 * When a session has consumed enough of its model's context window, the loop
 * starts a fresh session seeded from a written summary rather than continuing
 * until the model errors out. This replaces what a compaction plugin does,
 * with three differences that matter here:
 *
 * 1. **It happens between turns, never during one.** A handoff mid-turn would
 *    destroy the work in flight, so the only entry point is the completion
 *    path — the same place the loop already decides whether to continue.
 * 2. **It refuses to run while subagents are live.** A subagent is a child
 *    session; handing the parent off under one orphans its context and leaves
 *    the child writing into a session that no longer exists. The handoff
 *    defers instead, and the next turn retries.
 * 3. **The threshold is the window the session can actually use.** A 128k
 *    model and a 1M model should not hand off at the same token count, so the
 *    fraction is applied to the window of the model actually in use — and for
 *    a local model that is what the ollama daemon serves (`/api/ps`), not the
 *    catalogue's native size, because the daemon truncates the prompt to its
 *    own `OLLAMA_CONTEXT_LENGTH`.
 *
 * Pure functions do the deciding; `handoff` is the only part that touches I/O.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Fraction of the context window at which to hand off. */
export const DEFAULT_THRESHOLD = 0.5

export { DEFAULT_THRESHOLD as DEFAULT_HANDOFF_THRESHOLD }

/** How many recent turns to carry into the summary verbatim. */
const RECENT_TURNS = 6

/** A session reference, as the server reports it. */
export interface SessionRef {
  id: string
  parentID?: string | null
}

/** One turn of a transcript, already flattened. */
export interface TranscriptTurn {
  role: "user" | "assistant"
  text: string
}

/** What a handoff needs to write its summary. */
export interface SummaryInput {
  sessionID: string
  /** The original task the loop was given. */
  task: string
  /** Iterations completed in the session being closed. */
  iterations: number
  /** Why the handoff happened, for the record. */
  reason: string
  transcript: TranscriptTurn[]
  /** Files the session touched, when known. */
  files: string[]
}

export interface HandoffContext {
  session: {
    list(input?: { parentID?: string | null; limit?: number }): Promise<{ data?: unknown }>
    active(): Promise<unknown>
    create(input?: Record<string, unknown>): Promise<{ id?: string }>
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
  }
}

/* ------------------------------------------------------------------ measuring */

/**
 * Tokens of context a session has consumed.
 *
 * Read from the last assistant message's `tokens.input`, which is the prompt
 * size the provider actually reported — the whole conversation plus system
 * prompt, which is exactly what fills a window. Cache reads are added because
 * they are context that was read, not newly billed, and a long session on a
 * cache-heavy provider reads a lot.
 *
 * Returns 0 when no assistant message reports tokens, which means "not yet
 * measurable" rather than "empty": a fresh session legitimately has none, and
 * guessing from text length would be wrong by a factor of several.
 */
export function measureContext(messages: unknown): number {
  let latest = 0
  for (const message of asArray(messages)) {
    if (!isRecord(message)) continue
    const role = message.role ?? message.type
    if (role !== "assistant" && role !== "agent") continue
    const tokens = isRecord(message.tokens) ? message.tokens : null
    if (!tokens) continue
    const input = numberOr(tokens.input, 0)
    const cache = isRecord(tokens.cache) ? numberOr(tokens.cache.read, 0) : 0
    const total = input + cache
    if (total > latest) latest = total
  }
  return latest
}

/** Should a handoff happen at this usage? */
export function shouldHandoff(used: number, limit: number, threshold = DEFAULT_THRESHOLD): boolean {
  if (limit <= 0) return false
  return used >= limit * threshold
}

/**
 * The window a session can actually use, given two claims about it.
 *
 * A model's catalogue `context` is the architecture's native size, but the
 * runtime serving it may hold less — a local ollama daemon serves whatever
 * `OLLAMA_CONTEXT_LENGTH` says (64000 here) regardless of a native 3.5M, and
 * truncates the prompt to fit. Truncated turns produce almost no output and
 * the session never reaches a native-size threshold, so the loop stalls
 * exactly where a handoff should have happened. The smaller figure is the one
 * to measure; unknown values fall back to the other.
 */
export function effectiveContext(catalogueContext: number, servedContext: number): number {
  if (catalogueContext > 0 && servedContext > 0) return Math.min(catalogueContext, servedContext)
  return servedContext > 0 ? servedContext : catalogueContext
}

/**
 * The local ollama daemon's loaded-model listing.
 *
 * Same host as the tags probe in `lib/fetch.ts`; this asks what is *loaded*
 * because only a loaded model has a served window to read.
 */
export const OLLAMA_PS_URL = "http://localhost:11434/api/ps"

/**
 * The context window the local ollama daemon is serving `modelID`.
 *
 * Returns 0 for "unknown" — the daemon is down, the model is not loaded, or
 * the response is malformed — and callers fall back to the catalogue figure.
 */
export async function ollamaServedContext(modelID: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  try {
    const response = await fetchImpl(OLLAMA_PS_URL)
    if (!response.ok) return 0
    const body: unknown = await response.json()
    if (!isRecord(body)) return 0
    for (const entry of asArray(body.models)) {
      if (!isRecord(entry)) continue
      const name = typeof entry.name === "string" ? entry.name : typeof entry.model === "string" ? entry.model : ""
      if (name !== modelID) continue
      return numberOr(entry.context_length, 0)
    }
    return 0
  } catch {
    return 0
  }
}

/* ------------------------------------------------------------ subagent safety */

/**
 * Every session below `rootID`, at any depth.
 *
 * Subagents spawn children, which may spawn their own, so the walk is
 * transitive. A handoff is unsafe if *any* descendant is live, not just a
 * direct child.
 */
export function descendantIDs(all: readonly SessionRef[], rootID: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const session of all) {
    const parent = session.parentID ?? null
    if (!parent) continue
    const bucket = children.get(parent)
    if (bucket) bucket.push(session.id)
    else children.set(parent, [session.id])
  }

  const out = new Set<string>()
  const queue = [rootID]
  while (queue.length > 0) {
    const current = queue.pop()!
    for (const child of children.get(current) ?? []) {
      if (out.has(child)) continue
      out.add(child)
      queue.push(child)
    }
  }
  return out
}

/**
 * Which of these descendant sessions are currently running.
 *
 * `active` is the server's map of in-flight session ids; its keys are the ids.
 * An unreadable or empty value means "nothing active", which is the safe
 * reading — the failure mode that matters is proceeding while a subagent works,
 * so an unknown state must not be read as clear.
 */
export function busyDescendants(
  descendants: readonly string[],
  active: unknown,
): string[] {
  const activeIDs = activeSessionIDs(active)
  if (activeIDs.size === 0) return []
  const out: string[] = []
  for (const id of descendants) {
    if (activeIDs.has(id)) out.push(id)
  }
  return out
}

function activeSessionIDs(active: unknown): Set<string> {
  const out = new Set<string>()
  if (Array.isArray(active)) {
    for (const entry of active) {
      if (typeof entry === "string") out.add(entry)
      else if (isRecord(entry) && typeof entry.id === "string") out.add(entry.id)
      else if (isRecord(entry) && typeof entry.sessionID === "string") out.add(entry.sessionID)
    }
    return out
  }
  if (isRecord(active)) {
    for (const key of Object.keys(active)) out.add(key)
    const nested = (active as { data?: unknown }).data
    if (nested) return activeSessionIDs(nested)
  }
  return out
}

/**
 * Every session beneath `rootID`, fetched one parent at a time.
 *
 * The session listing is paginated and location-scoped, so listing every
 * session and filtering by `parentID` (as `descendantIDs` does) can truncate
 * a wide tree away. Walking level by level against the `parentID` filter
 * cannot: each page is the direct children of one session, and the walk stops
 * when a level comes back empty.
 *
 * I/O lives here; the pure tree walk is `descendantIDs`.
 */
export async function sessionTree(
  ctx: Pick<HandoffContext, "session">,
  rootID: string,
  limit = 200,
): Promise<string[]> {
  const out = new Set<string>()
  let frontier = [rootID]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const parent of frontier) {
      let listed: unknown
      try {
        listed = await ctx.session.list({ parentID: parent, limit })
      } catch {
        return [...out]
      }
      for (const ref of toSessionRefs(listed)) {
        if (ref.id === parent || out.has(ref.id)) continue
        out.add(ref.id)
        next.push(ref.id)
      }
    }
    frontier = next
  }
  return [...out]
}

/* ---------------------------------------------------------------- summarising */

/**
 * Build the summary file's contents.
 *
 * Deterministic, not model-written: a summary that costs a model call has a
 * failure mode that loses the session, and the transcript is the authoritative
 * record of what happened. The shape keeps what a continuation actually needs —
 * the task verbatim, the recent turns verbatim for immediate context, older
 * turns condensed to one line each, and the files touched so the next session
 * knows where the work landed.
 */
export function buildSummary(input: SummaryInput): string {
  const lines: string[] = []
  lines.push("# dont-stop context handoff")
  lines.push("")
  lines.push(`Session \`${input.sessionID}\` reached its context threshold and was closed.`)
  lines.push(`Completed ${input.iterations} iteration(s). ${input.reason}`)
  lines.push("")
  lines.push("## Task")
  lines.push("")
  lines.push(input.task.trim() || "(no task recorded)")
  lines.push("")

  if (input.files.length > 0) {
    lines.push("## Files touched")
    lines.push("")
    for (const file of input.files) lines.push(`- \`${file}\``)
    lines.push("")
  }

  const turns = input.transcript
  if (turns.length > 0) {
    const recent = turns.slice(-RECENT_TURNS)
    const older = turns.slice(0, Math.max(0, turns.length - RECENT_TURNS))

    if (older.length > 0) {
      lines.push("## Earlier turns (condensed)")
      lines.push("")
      for (const turn of older) lines.push(`- **${turn.role}**: ${condense(turn.text)}`)
      lines.push("")
    }

    if (recent.length > 0) {
      lines.push("## Recent turns (verbatim)")
      lines.push("")
      for (const turn of recent) {
        lines.push(`### ${turn.role}`)
        lines.push("")
        lines.push(turn.text.trim() || "(empty)")
        lines.push("")
      }
    }
  }

  lines.push("## Continue")
  lines.push("")
  lines.push("Resume the task above from where it left off. The verbatim turns are the")
  lines.push("most recent work; anything before them is summarised above. Read any files")
  lines.push("listed to re-establish the current state before continuing.")
  return lines.join("\n")
}

/** One-line a turn, keeping its opening clause. */
function condense(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= 160) return flat || "(empty)"
  return `${flat.slice(0, 157)}...`
}

/** Where a session's summary is written. */
export function summaryPath(directory: string, sessionID: string): string {
  return join(directory, `${sessionID}.md`)
}

/** Flatten a session's messages into turns, extracting files from tool calls. */
export function transcriptFrom(messages: unknown): { turns: TranscriptTurn[]; files: string[] } {
  const turns: TranscriptTurn[] = []
  const files: string[] = []
  const seenFiles = new Set<string>()

  for (const message of asArray(messages)) {
    if (!isRecord(message)) continue
    const role = message.role ?? message.type
    if (role !== "user" && role !== "assistant" && role !== "agent") continue
    const bucket = role === "user" ? "user" : "assistant"

    let text = ""
    // v2 lists parts under `content`; older responses under `parts`. Both hold
    // the same shapes: text, reasoning and tool parts.
    const parts = [...asArray(message.content), ...asArray(message.parts)]
    for (const part of parts) {
      if (!isRecord(part)) continue
      const type = typeof part.type === "string" ? part.type : ""
      if (typeof part.text === "string" && (type === "" || type === "text")) text += part.text
      else if (typeof part.content === "string" && (type === "" || type === "text")) text += part.content

      // A tool part names the file it acted on. v2 puts the arguments under
      // `state.input`, older shapes under `input`; the field itself is `path`
      // (write/edit) or `filePath` (read) or `filename`.
      const input = toolInput(part)
      const candidate = input ? (input.path ?? input.filePath ?? input.filename) : undefined
      if (type.startsWith("tool") && typeof candidate === "string" && !seenFiles.has(candidate)) {
        seenFiles.add(candidate)
        files.push(candidate)
      }
    }

    if (text.trim().length > 0) {
      turns.push({ role: bucket, text })
      continue
    }
    // v2 keeps user-turn text on the message itself; older shapes on parts.
    if (typeof message.text === "string" && message.text.trim().length > 0) {
      turns.push({ role: bucket, text: message.text })
    }
  }

  return { turns, files }
}

/** The arguments a tool part ran with, in whichever shape they arrive. */
function toolInput(part: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(part.input)) return part.input
  const state = part.state
  if (isRecord(state) && isRecord(state.input)) return state.input
  return null
}

/* -------------------------------------------------------------------- handoff */

export interface HandoffResult {
  handed: boolean
  /** Why not, when `handed` is false. */
  deferred?: string
  summaryFile?: string
  newSessionID?: string
  /** Sessions that were live and forced the deferral. */
  busy?: string[]
}

/**
 * Close a session and open its successor.
 *
 * Order matters: the summary is written *before* the new session is created, so
 * a failure to write leaves the original session untouched and the loop simply
 * continues in place. The new session is created and prompted with a pointer to
 * the file rather than its contents, because the point of the handoff is to
 * start with a small window.
 */
export async function handoff(
  ctx: HandoffContext,
  input: SummaryInput,
  options: { directory: string; agent?: string },
): Promise<HandoffResult> {
  // Refuse while any descendant session is live.
  const descendants = await sessionTree(ctx, input.sessionID)

  let active: unknown = null
  try {
    active = await ctx.session.active()
  } catch {
    active = null
  }

  const busy = busyDescendants(descendants, active)
  if (busy.length > 0) {
    return { handed: false, deferred: "subagents still running", busy }
  }

  const file = summaryPath(options.directory, input.sessionID)
  try {
    mkdirSync(options.directory, { recursive: true })
    writeFileSync(file, buildSummary(input), "utf8")
  } catch (error) {
    return { handed: false, deferred: `could not write the summary: ${messageOf(error)}` }
  }

  let newSessionID: string
  try {
    const created = await ctx.session.create({
      title: `dont-stop continuation of ${input.sessionID}`,
      ...(options.agent ? { agent: options.agent } : {}),
    })
    newSessionID = created?.id ?? ""
    if (!newSessionID) return { handed: false, deferred: "new session had no id", summaryFile: file }
  } catch (error) {
    return { handed: false, deferred: `could not create a session: ${messageOf(error)}`, summaryFile: file }
  }

  const seed =
    `A previous session reached its context limit and was closed. Its summary is at ` +
    `\`${file}\` — read it first.\n\n` +
    `Original task: ${input.task.trim() || "(none recorded)"}`

  try {
    await ctx.session.prompt({ sessionID: newSessionID, text: seed })
  } catch (error) {
    // The session exists and the summary is written; only the opening prompt
    // failed. Report it rather than pretending the handoff was clean.
    return { handed: false, deferred: `session created but unprompted: ${messageOf(error)}`, summaryFile: file, newSessionID }
  }

  return { handed: true, summaryFile: file, newSessionID }
}

/* ------------------------------------------------------------------- helpers */

function toSessionRefs(listed: unknown): SessionRef[] {
  const rows = isRecord(listed) && Array.isArray((listed as { data?: unknown }).data)
    ? ((listed as { data: unknown[] }).data as unknown[])
    : asArray(listed)
  const out: SessionRef[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = typeof row.id === "string" ? row.id : typeof row.sessionID === "string" ? row.sessionID : null
    if (!id) continue
    const parent = row.parentID
    out.push({ id, parentID: typeof parent === "string" ? parent : null })
  }
  return out
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value.data)) return value.data as unknown[]
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
