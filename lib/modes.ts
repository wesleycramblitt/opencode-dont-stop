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
  isFree,
  sortBy,
  sorts,
  type Catalogue,
  type CatalogueModel,
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
export function rankForMode(cat: Catalogue, mode: Mode, task: TaskProfile): CatalogueModel[] {
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
      return rankLocal(cat, candidates, task)
    case "power":
      return rankPower(candidates, task)
  }
}

/**
 * Free mode: sweep opencode-go/zen free models by capability, then fall back to
 * the best local model.
 *
 * The split matters. Remote free rows come first because that is what the mode
 * promises; a local row only appears when the free sweep has no remote
 * candidate, which is the "check again for free models" fallback rather than a
 * silent substitution. A later sweep that finds a remote free model available
 * again naturally promotes it ahead of the local fallback.
 */
function rankFree(candidates: CatalogueModel[], task: TaskProfile): CatalogueModel[] {
  const remoteFree = candidates.filter((m) => !m.local && isFree(m))
  const local = candidates.filter((m) => m.local)

  // Verified free rows first: confirmed free and confirmed capable.
  const verified = sortBy(remoteFree.filter((m) => !m.provenance.estimated), sorts.verifiedFirst)
  const estimated = sortBy(remoteFree.filter((m) => m.provenance.estimated), sorts.capabilityContext)

  // Local fallback: best local model for the task.
  const localRanked = sortBy(local, sorts.capabilityContext)

  return [...verified, ...estimated, ...localRanked]
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
 * Shape: three cheapest paid rows, then three most capable paid rows, then the
 * free rows and local fallbacks. The head minimises spend; the paid tail gives
 * the loop somewhere to go when a cheap model is too weak, without leaving the
 * mode; the free tail is the degradation target.
 */
function rankCheap(candidates: CatalogueModel[], task: TaskProfile): CatalogueModel[] {
  const qualified = candidates.filter((m) => meetsTask(m, task))
  const pool = qualified.length > 0 ? qualified : candidates

  const paid = pool.filter((m) => !isFree(m))
  const free = pool.filter(isFree)

  const byPrice = sortBy(paid, sorts.cheapest)
  const cheapestPaid = byPrice.slice(0, 3)
  const capablePaid = sortBy(paid, sorts.capability).slice(0, 3)

  // Free remote rows first among the free tail (they are the free sweep), then
  // local models as the last resort.
  const freeRemote = sortBy(free.filter((m) => !m.local), sorts.capabilityContext)
  const freeLocal = sortBy(free.filter((m) => m.local), sorts.capabilityContext)

  return dedupe([
    ...cheapestPaid,
    ...capablePaid,
    ...freeRemote,
    ...freeLocal,
  ])
}

/**
 * Local mode: best local model for the task, mindful of GPU budget.
 *
 * Local rows are ranked by capability among those that fit the task's *facts*
 * — context and capability columns, which are real — rather than its derived
 * score floors, which are priors. A local row below a derived bar is still the
 * best available local option and must not be discarded for it.
 *
 * A remote row appears only when there is no local model at all, so the mode
 * stays honest about being local: falling back to a paid API because every
 * local row is merely "too weak" would make the mode a silent lie.
 */
function rankLocal(cat: Catalogue, candidates: CatalogueModel[], task: TaskProfile): CatalogueModel[] {
  const localFacts = (m: CatalogueModel) => m.local && m.available && (m.context <= 0 || m.context >= task.minContext)

  const fitting = sortBy(candidates.filter(localFacts), sorts.capabilityContext)
  if (fitting.length > 0) return fitting

  // Relax the context bar: a partially-fitting local row still beats a paid
  // API call, and the mode promised local.
  const loose = sortBy(candidates.filter((m) => m.local && m.available), sorts.capabilityContext)
  if (loose.length > 0) return loose

  // Nothing local is installed at all: allow remote rather than fail the task.
  const remote = candidates.filter((m) => meetsTask(m, task))
  return sortBy(remote.length > 0 ? remote : candidates, sorts.capabilityContext)
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
      return "sweep free opencode-go/zen models, fall back to best local"
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

export {
  blendedPrice,
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
