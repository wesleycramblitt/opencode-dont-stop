/**
 * dont-stop — Mode strategies.
 *
 * A mode is a policy, not a list. Each mode answers three questions:
 *
 * 1. What does a *task* require of a model? (capability, context, price)
 * 2. Which models satisfy it, and in what order should they be tried?
 * 3. When one fails, what does the mode do about it?
 *
 * Every strategy is a deterministic filter-and-sort over the catalogue, so a
 * decision can always be replayed and explained. The ranking adjusts for the
 * agent type because an architect and a build agent want different things from
 * the same catalogue.
 *
 * Verified rows outrank estimated ones through the comparators, never by being
 * the only candidates: most of the catalogue is unbenchmarked, so excluding
 * estimates would leave nearly every query empty.
 */

import {
  blendedPrice,
  filter,
  fitsLocally,
  isFree,
  sortBy,
  sorts,
  type Catalogue,
  type CatalogueModel,
  HARDWARE_4090,
  type HardwareProfile,
  type Requirements,
} from "./catalogue.ts"
import type { Mode } from "./state.ts"

/** The agent kinds opencode uses, plus a catch-all. */
export type AgentKind = "architect" | "build" | "review" | "general" | "explore" | "other"

/** What a kind of work demands of a model. */
export interface TaskProfile {
  kind: AgentKind
  /** True when the task involves reading images, screenshots or diagrams. */
  vision?: boolean
  /** Minimum context in tokens worth spending on this task. */
  minContext: number
  /** Weight 0-1 on code strength vs general strength for this task. */
  codeWeight: number
  /** True when the work is primarily planning rather than editing. */
  planning: boolean
}

/** Capability requirements derived from a task profile. */
export function requirementsFor(task: TaskProfile): Requirements {
  return {
    // Every mode drives an agent, so text input is a hard floor. This is what
    // keeps ASR/TTS/embedding models out of every pool regardless of price or
    // context: they do not accept a text prompt at all.
    text: true,
    vision: task.vision || undefined,
    minContext: task.minContext,
    minCode: task.planning ? undefined : Math.round(3 + task.codeWeight * 5),
    allowLocal: undefined,
  }
}

// `Requirements.minCode` is a numeric strength floor; the task profile's
// `codeWeight` is mapped onto it there.

/**
 * Per-agent baseline profiles. These are defaults; a caller can override any
 * field.
 */
export const AGENT_PROFILES: Record<AgentKind, Omit<TaskProfile, "vision">> = {
  // Architects read diagrams and reason across a large surface, so they want
  // vision and the biggest context available, and they benefit from strong
  // reasoning rather than raw code throughput.
  architect: { kind: "architect", minContext: 100000, codeWeight: 0.3, planning: true },
  // Build agents edit code: strong code, enough context for a real file tree,
  // and no need for vision in the common case.
  build: { kind: "build", minContext: 32000, codeWeight: 0.8, planning: false },
  // Review reads diffs and reasons about correctness. Code-heavy, moderate
  // context, benefits from reasoning.
  review: { kind: "review", minContext: 64000, codeWeight: 0.7, planning: false },
  // General purpose assistance.
  general: { kind: "general", minContext: 32000, codeWeight: 0.5, planning: false },
  // Exploration reads widely and navigates; vision helps with screenshots.
  explore: { kind: "explore", minContext: 64000, codeWeight: 0.4, planning: false },
  other: { kind: "other", minContext: 32000, codeWeight: 0.5, planning: false },
}

/** Build a task profile for an agent kind, inheriting that kind's defaults. */
export function profileFor(kind: AgentKind, overrides: Partial<TaskProfile> = {}): TaskProfile {
  const base = AGENT_PROFILES[kind] ?? AGENT_PROFILES.other
  return { ...base, ...overrides, kind }
}

/** Rank rows for one task under one mode. Pure and deterministic. */
export function rankForMode(
  cat: Catalogue,
  mode: Mode,
  task: TaskProfile,
  hardware: HardwareProfile = HARDWARE_4090,
): CatalogueModel[] {
  // `stop` is not a real mode: it selects nothing so the loop can halt.
  if (mode === "stop") return []
  const req = requirementsFor(task)
  const candidates = filter(cat, req)
  if (candidates.length === 0) return []

  switch (mode) {
    case "free":
      return rankFree(candidates, task)
    case "cheap":
      return rankCheap(candidates, task)
    case "local":
      return rankLocal(cat, candidates, task, hardware)
    case "power":
      return rankPower(candidates, task)
  }
}

/**
 * Free mode: sweep zero-cost models by capability, then quota-backed models,
 * then fall back to the best local model.
 *
 * The split matters. Remote free rows come first because that is what the mode
 * promises; quota-backed rows — paid models with a declared promotional free
 * allowance (see `data/free-tiers.ts`) — come next because they are the next
 * cheapest thing that can run without a bill; local rows are the tail, reached
 * only once every remote row has had its try. Rotation walks this list in
 * order, so a run of rate limits walks down through the free sweep and out the
 * other side into local rather than stopping or cycling.
 *
 * A remote row that comes off cooldown re-enters this list *ahead* of the local
 * tail, so a rate-limited free model whose timeout is up wins its turn back
 * before the loop spends one on a local model.
 */
function rankFree(candidates: CatalogueModel[], task: TaskProfile): CatalogueModel[] {
  const remoteFree = candidates.filter((m) => !m.local && isFree(m))
  const quota = candidates.filter((m) => !m.local && !isFree(m) && m.freeTier !== null)
  const local = candidates.filter((m) => m.local)

  // Verified free rows first: confirmed free and confirmed capable.
  const verified = sortBy(remoteFree.filter((m) => !m.provenance.estimated), sorts.verifiedFirst)
  const estimated = sortBy(remoteFree.filter((m) => m.provenance.estimated), sorts.capabilityContext)

  // Quota-backed rows: the free allowance is the reason they are here, and
  // within it the better model should be tried first.
  const quotaRanked = sortBy(quota, sorts.capabilityContext)

  // Local fallback: best local model for the task.
  const localRanked = sortBy(local, sorts.capabilityContext)

  return [...verified, ...estimated, ...quotaRanked, ...localRanked]
}

/**
 * Cheap mode: cheapest *paid* remote model that can actually do the task.
 *
 * The spec is explicit that cheap is not free: it spends a little to get past
 * what the free tier offers, and degrades to free only when funds run out. So
 * a free row is the tail of the chain, not its head — leading with free would
 * make this mode a duplicate of free mode and leave the degradation nowhere
 * to go.
 *
 * A row only enters the chain if it can do the task: the cheapest *vision*
 * model when vision is required, the cheapest *tool-calling* model when tools
 * are needed. Among rows that qualify, price decides and capability breaks
 * ties.
 *
 * Shape: every paid row cheapest-first, then the free rows, then the local
 * fallbacks — the same walk free mode makes, one try per model, with the paid
 * head in front. The head minimises spend; the paid tail gives the loop
 * somewhere to go when a cheap model is too weak, without leaving the mode; the
 * free and local tails are the degradation targets, reached only once the paid
 * rows have all had their try.
 */
function rankCheap(candidates: CatalogueModel[], task: TaskProfile): CatalogueModel[] {
  const qualified = candidates.filter((m) => meetsTask(m, task))
  const pool = qualified.length > 0 ? qualified : candidates

  const paid = pool.filter((m) => !isFree(m))
  const free = pool.filter(isFree)

  // Free remote rows first among the free tail (they are the free sweep), then
  // local models as the last resort.
  const freeRemote = sortBy(free.filter((m) => !m.local), sorts.capabilityContext)
  const freeLocal = sortBy(free.filter((m) => m.local), sorts.capabilityContext)

  return dedupe([
    ...sortBy(paid, sorts.cheapest),
    ...freeRemote,
    ...freeLocal,
  ])
}

/**
 * Local mode: best model that actually runs on this machine.
 *
 * "Local" means runnable here, not merely listed on ollama.com. Two filters
 * separate them:
 *
 * 1. **Not cloud-hosted.** ollama.com tags a model `cloud` when it runs on
 *    Ollama's servers; those are rented compute and must not appear here.
 * 2. **Fits the GPU.** A model whose *total* parameter count exceeds what the
 *    card can hold will not load, so it is not a candidate no matter how well
 *    it scores. Sizing uses total parameters because that is what must be
 *    resident, at the default pull quantization.
 *
 * Models whose weights are unpublished are excluded rather than assumed to
 * fit: an unknown may or may not load, and local mode promising it is how a
 * user ends up with an out-of-memory error mid-loop.
 */
function rankLocal(cat: Catalogue, candidates: CatalogueModel[], task: TaskProfile, hardware: HardwareProfile): CatalogueModel[] {
  const fits = (m: CatalogueModel) =>
    m.local && !m.cloud && (m.context <= 0 || m.context >= task.minContext) && fitsLocally(m, hardware) === true

  const fitting = sortBy(candidates.filter(fits), sorts.capabilityContext)
  if (fitting.length > 0) return fitting

  // Relax the context bar before anything else: a partially-fitting local row
  // still beats going remote, and the mode promised local.
  const loose = sortBy(
    candidates.filter((m) => m.local && !m.cloud && fitsLocally(m, hardware) === true),
    sorts.capabilityContext,
  )
  if (loose.length > 0) return loose

  // Nothing local is installed that fits. Reporting that plainly is more useful
  // than silently substituting a paid API for a mode whose whole point is local.
  return []
}

/**
 * Power mode: most capable model that can actually do the task, re-evaluated
 * per turn. Ranking favours the task's dominant strength and breaks ties on
 * capability and context, so "power" means "most powerful *for this*", not
 * "most expensive".
 */
function rankPower(candidates: CatalogueModel[], task: TaskProfile): CatalogueModel[] {
  const qualified = candidates.filter((m) => meetsTask(m, task))
  const pool = qualified.length > 0 ? qualified : candidates
  return sortBy(pool, (a, b) => {
    const dominant = task.codeWeight >= 0.5 ? "code" : "reasoning"
    const da = dominant === "code" ? a.scores.code : a.scores.reasoning
    const db = dominant === "code" ? b.scores.code : b.scores.reasoning
    if (da !== db) return db - da
    // Prefer a row whose scores come from a report over a derived estimate.
    if (a.provenance.estimated !== b.provenance.estimated) return a.provenance.estimated ? 1 : -1
    if (a.scores.capability !== b.scores.capability) return b.scores.capability - a.scores.capability
    return b.context - a.context
  })
}

/** Can this row carry the task, judged on capability rather than presence? */
function meetsTask(m: CatalogueModel, task: TaskProfile): boolean {
  if (!m.available) return false
  if (m.context > 0 && m.context < task.minContext) return false
  if (task.planning && m.scores.reasoning < 5) return false
  return true
}

function dedupe(models: CatalogueModel[]): CatalogueModel[] {
  const seen = new Set<string>()
  const out: CatalogueModel[] = []
  for (const m of models) {
    if (seen.has(m.key)) continue
    seen.add(m.key)
    out.push(m)
  }
  return out
}

/* ------------------------------------------------------- mode relationships */

/**
 * The order over modes by what a mode costs the user, used when a mode must
 * degrade.
 *
 * `local` is deliberately *not* cheaper than `free` here. Locality is a
 * different axis from price: a local model is the free-mode *fallback*, not a
 * tier below it, and a user who asked for free models does not want to be
 * pushed onto their GPU when the free sweep is merely rate limited. The
 * degradation the spec asks for is cheap -> free on low funds, so free sits
 * directly above cheap and the chain ends there.
 */
const MODE_ORDER: Record<Mode, number> = {
  power: 3,
  cheap: 2,
  free: 1,
  local: 0,
  stop: -1,
}

/**
 * The next cheaper mode. Returns the mode itself when already cheapest, so a
 * caller can loop until the value stops changing.
 *
 * `local` is terminal on this axis: it is not a fallback for the other modes
 * (each of them already falls back to a local model on its own when it has no
 * candidate), so degrading *to* local from free would be a lateral move that
 * loses the free sweep for no gain.
 */
export function degrade(mode: Mode): Mode {
  if (mode === "stop") return "stop"
  const current = MODE_ORDER[mode]
  const cheaper = (Object.keys(MODE_ORDER) as Array<Exclude<Mode, "stop">>).filter(
    (m) => MODE_ORDER[m] < current && MODE_ORDER[m] > 0,
  )
  if (cheaper.length === 0) return mode
  return cheaper.reduce((best, m) => (MODE_ORDER[m] < MODE_ORDER[best] ? m : best))
}

/**
 * The chain of modes a task descends through on repeated failure. Free is
 * terminal on this axis: once the free sweep and its own local fallback are
 * exhausted there is no cheaper mode to try, so the chain ends at free rather
 * than detouring through local.
 */
export function degradationChain(mode: Mode): Mode[] {
  if (mode === "stop") return ["stop"]
  const chain: Mode[] = [mode]
  let current: Mode = mode
  for (let i = 0; i < 4; i++) {
    const next = degrade(current)
    if (next === current || chain.includes(next)) break
    chain.push(next)
    current = next
  }
  return chain
}

/** Is this mode cheaper than that one? */
export function isCheaperThan(a: Mode, b: Mode): boolean {
  if (a === "stop" || b === "stop") return a === "stop" && b !== "stop"
  return MODE_ORDER[a] < MODE_ORDER[b]
}

/**
 * Whether a mode should try remote models at all. Free and cheap sweep remote
 * providers; local and stop do not (local is local, stop is nothing).
 */
export function allowsRemote(mode: Mode): boolean {
  return mode === "free" || mode === "cheap" || mode === "power"
}

/** Human-readable explanation of a mode's intent, for status output. */
export function describeMode(mode: Mode): string {
  switch (mode) {
    case "free":
      return "sweep free models, then quota-backed, then best local"
    case "cheap":
      return "cheapest capable model per task; degrade to free on low funds"
    case "local":
      return "best local model per task, GPU-aware"
    case "power":
      return "most capable model per agent and task, re-evaluated each turn"
    case "stop":
      return "loop halted"
  }
}

export { HARDWARE_4090, blendedPrice,
  filter,
  isFree,
  sortBy,
  sorts,
  type Catalogue,
  type CatalogueModel,
  type Requirements,
}

/** Every agent kind the engine plans for, in a stable order. */
export const AGENT_KINDS: ReadonlyArray<AgentKind> = [
  "architect",
  "build",
  "review",
  "explore",
  "general",
]
