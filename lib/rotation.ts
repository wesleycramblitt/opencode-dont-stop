/**
 * dont-stop — Session rotation.
 *
 * A loop that runs for hours degrades: a long conversation makes the model
 * worse at the work, not just slower, and a fresh session with the same loop
 * prompt cures it. This module is the mechanism that starts one. It replaces
 * the summary-based handoff: rotation carries nothing at all, because the
 * repository is the state — plans, task files, the codebase index — and a
 * summary of a session that already wrote its work to disk is redundant.
 *
 * Three things decide when to rotate, all in `lib/engine.ts`:
 *
 * 1. **A task boundary.** The model says a unit of work is done
 *    (`<loop-checkpoint/>`), or that everything is done (`<loop-complete/>`).
 * 2. **A session step budget.** Turns spent in one session.
 * 3. **Context pressure.** Usage at a fraction of the effective window, so
 *    the emergency backstop — OpenCode's own auto-compaction — stays
 *    theoretical rather than being the mechanism that saves a session.
 *
 * Two properties make rotation safe:
 *
 * 1. **It happens between turns, never during one.** The only entry point is
 *    the completion path — the turn has ended, no request is in flight, and
 *    the work that turn did is already on disk.
 * 2. **It refuses to run while subagents are live.** A subagent is a child
 *    session; rotating the parent under one orphans its context and leaves it
 *    writing into a session that no longer exists. The walk is transitive —
 *    grandchildren count — and a deferral is remembered and retried on the
 *    next turn.
 *
 * Pure functions do the deciding; `rotate` is the only part that touches I/O.
 */

/** Fraction of the effective window at which to rotate. */
export const DEFAULT_ROTATION_THRESHOLD = 0.8

/** A session reference, as the server reports it. */
export interface SessionRef {
  id: string
  parentID?: string | null
}

/** The session API surface rotation needs. */
export interface RotationContext {
  session: {
    list(input?: { parentID?: string | null; limit?: number }): Promise<{ data?: unknown }>
    active(): Promise<unknown>
    create(input?: Record<string, unknown>): Promise<{ id?: string }>
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
    remove(input: { sessionID: string }): Promise<unknown>
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

/** Should a rotation happen at this usage? */
export function shouldRotate(used: number, limit: number, threshold = DEFAULT_ROTATION_THRESHOLD): boolean {
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
 * exactly where a rotation should have happened. The smaller figure is the one
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
 * transitive. A rotation is unsafe if *any* descendant is live, not just a
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
  ctx: Pick<RotationContext, "session">,
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

/* -------------------------------------------------------------------- rotating */

export interface RotationResult {
  rotated: boolean
  /** Why not, when `rotated` is false. */
  deferred?: string
  /** Sessions that were live and forced the deferral. */
  busy?: string[]
  newSessionID?: string
  /** Whether the retired session was deleted after a successful rotation. */
  deletedOld?: boolean
  /** The deletion error when the retired session could not be removed. */
  deleteError?: string
}

/**
 * Start the loop's successor session and seed it with the loop prompt.
 *
 * The session is created empty: no history, no tool calls, no summary. The
 * seed tells the model plainly that the repository is the state and that it
 * must re-establish where the work stands before continuing — which is what
 * the loop's own prompt asks of a first turn anyway.
 */
export async function rotate(
  ctx: RotationContext,
  input: { sessionID: string; seed: string; agent?: string; title?: string },
): Promise<RotationResult> {
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
    return { rotated: false, deferred: "subagents still running", busy }
  }

  let newSessionID: string
  try {
    const created = await ctx.session.create({
      title:
        input.title ??
        `dont-stop continuation of ${input.sessionID}`,
      ...(input.agent ? { agent: input.agent } : {}),
    })
    newSessionID = created?.id ?? ""
    if (!newSessionID) return { rotated: false, deferred: "new session had no id" }
  } catch (error) {
    return { rotated: false, deferred: `could not create a session: ${messageOf(error)}` }
  }

  try {
    await ctx.session.prompt({ sessionID: newSessionID, text: input.seed })
  } catch (error) {
    // The session exists but is unprompted. Report it rather than pretending
    // the rotation was clean; the engine keeps the loop in place and retries.
    return { rotated: false, deferred: `session created but unprompted: ${messageOf(error)}`, newSessionID }
  }

  // The retired session is deleted once its successor is seeded. Failure is
  // non-fatal: the loop is already on the successor, and the old session
  // (left intact and idle) is what stays. The reason is reported so the
  // engine can log it where the user can see it.
  let deletedOld = false
  let deleteError: string | undefined
  try {
    await ctx.session.remove({ sessionID: input.sessionID })
    deletedOld = true
  } catch (error) {
    deleteError = messageOf(error)
    console.warn(`[dont-stop] could not delete retired session ${input.sessionID}: ${deleteError}`)
  }

  return { rotated: true, newSessionID, deletedOld, deleteError }
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
