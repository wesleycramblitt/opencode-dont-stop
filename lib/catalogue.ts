/**
 * dont-stop — Model Catalogue.
 *
 * The catalogue is a **data table**, not an algorithm. Rows are fetched from
 * real sources (see `lib/fetch.ts`) and persisted to `data/catalogue.json`,
 * which is loaded read-only at runtime. Nothing here estimates a model's
 * ability to fill in for a missing report: a row without curated benchmarks
 * is marked `estimated` in its provenance and every derived field is listed,
 * so a ranking made on derived data is always distinguishable from one made on
 * a published report.
 *
 * Ranking is a deterministic filter-and-sort over that table. Mode policy
 * lives in `lib/modes.ts`; this module owns the rows and the predicates.
 */

import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { CATALOGUE_FILE } from "./fetch.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const FALLBACK_PATH = join(HERE, "..", "data", "catalogue.json")

/** Capability columns, matching the persisted row shape. */
export interface Capabilities {
  text: boolean
  image: boolean
  audio: boolean
  pdf: boolean
  video: boolean
  reasoning: boolean
  toolCall: boolean
  structured: boolean
  embedding: boolean
}

export interface Pricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface Scores {
  reasoning: number
  code: number
  agentic: number
  general: number
  capability: number
}

/**
 * Parameter counts, split because they answer different questions.
 *
 * `total` is what must be held in memory and so governs VRAM feasibility.
 * `active` is what runs per forward pass and so governs effective capability.
 * For a dense model they are equal; for a mixture-of-experts model they differ
 * by an order of magnitude, and conflating them makes both estimates wrong.
 */
export interface Weights {
  total: number | null
  active: number | null
  moe: boolean
  source: "tag" | "description" | "description-active" | "registry" | "unknown"
}

/** A card to size local models against. */
export interface HardwareProfile {
  name: string
  /** Total VRAM in GB. */
  vramGB: number
  /** Quantization a `pull` fetches by default. */
  quant: "q4" | "q5" | "q8" | "f16"
}

/** An RTX 4090, the common local-first card. */
export const HARDWARE_4090: HardwareProfile = { name: "rtx-4090", vramGB: 24, quant: "q4" }

const QUANT_BYTES_PER_PARAM: Record<HardwareProfile["quant"], number> = {
  q4: 0.6,
  q5: 0.75,
  q8: 1.05,
  f16: 2.0,
}

/** Reserve for the KV cache, activations and CUDA overhead, in GB. */
const VRAM_RESERVE_GB = 2.5

/**
 * Estimated VRAM in GB to run a model, or null when its weights are unknown.
 * Unknown is distinct from small: a model whose size is not published may not
 * fit, and local mode must not assume it does.
 */
export function estimateVRAM(m: CatalogueModel, profile: HardwareProfile = HARDWARE_4090): number | null {
  const total = m.weights.total
  if (total === null || !Number.isFinite(total)) return null
  return round1(total * QUANT_BYTES_PER_PARAM[profile.quant] + VRAM_RESERVE_GB)
}

/**
 * Does this model fit in the profile's VRAM? Null when the weights are unknown.
 *
 * The 0.88 margin leaves room for the desktop compositor and anything else
 * holding VRAM — a card with 24GB rarely offers 24GB to a single process.
 */
export function fitsLocally(m: CatalogueModel, profile: HardwareProfile = HARDWARE_4090): boolean | null {
  const vram = estimateVRAM(m, profile)
  if (vram === null) return null
  return vram <= profile.vramGB * 0.88
}

export interface Provenance {
  metadata: "models.dev" | "ollama" | "local"
  /** The benchmark report a row's scores came from, when it has one. */
  benchmark: string | null
  /** True when `scores` was derived from metadata, not read from a report. */
  estimated: boolean
  estimatedFields: string[]
}

/** One catalogue row: a model, or a variant of one. */
export interface CatalogueModel {
  key: string
  providerID: string
  id: string
  /** Set when this row describes a variant rather than the base model. */
  variant?: string
  name: string
  description: string
  family: string
  releaseDate: string
  knowledge: string
  openWeights: boolean
  context: number
  maxOutput: number
  capabilities: Capabilities
  pricing: Pricing
  local: boolean
  ollamaRank?: number
  canonicalID: string | null
  benchmarks: Record<string, number | string> | null
  scores: Scores
  provenance: Provenance
  /**
   * Parameter counts. `total` governs VRAM, `active` governs capability; see
   * the interface. Both null when the model publishes neither.
   */
  weights: Weights
  /** True when a provider hosts this remotely rather than on this machine. */
  cloud: boolean
  /**
   * Whether the running OpenCode can route to this provider. False means it
   * cannot — no credential is held — so no mode may select it however well it
   * ranks. Reachability is re-derived by the engine at load from the live
   * server, so the committed file only carries the fetch-time view.
   */
  reachable: boolean
  /** Availability is runtime state, not catalogue data: set by the engine. */
  available: boolean
  availabilityReason: string | null
  cooldownUntil: number
}

/** An availability override applied when loading, so state survives reloads. */
export interface AvailabilityPatch {
  key: string
  available: boolean
  reason?: string
}

export interface Catalogue {
  version: number
  generatedAt: string
  sources: Array<{ id: string; url: string; models: number }>
  models: CatalogueModel[]
  byKey: Map<string, CatalogueModel>
  byProvider: Map<string, CatalogueModel[]>
  byCanonical: Map<string, CatalogueModel[]>
}

export function slotKey(providerID: string, id: string, variant?: string): string {
  return variant ? `${providerID}/${id}#${variant}` : `${providerID}/${id}`
}

/* ------------------------------------------------------------------- loading */

/** The persisted document shape. Only `models` and provenance are consumed. */
interface PersistedDocument {
  version?: number
  generatedAt?: string
  sources?: Array<{ id: string; url: string; models: number }>
  models?: Array<Record<string, unknown>>
}

/**
 * Load the catalogue from disk, returning null when it is absent or
 * unreadable. A missing catalogue is a normal state before the first
 * `update-model-catalogue`, not an error.
 */
export function loadCatalogue(path: string = CATALOGUE_FILE): Catalogue | null {
  const file = existsSync(path) ? path : FALLBACK_PATH
  if (!existsSync(file)) return null
  try {
    const document = JSON.parse(readFileSync(file, "utf8")) as PersistedDocument
    return index(toModels(document.models ?? []), {
      version: document.version ?? 1,
      generatedAt: document.generatedAt ?? "",
      sources: document.sources ?? [],
    })
  } catch {
    return null
  }
}

/** Coerce persisted rows into catalogue models, defaulting unknown fields. */
function toModels(rows: Array<Record<string, unknown>>): CatalogueModel[] {
  const models: CatalogueModel[] = []
  for (const raw of rows) {
    const providerID = str(raw.providerID)
    const id = str(raw.id)
    if (!providerID || !id) continue
    const variant = typeof raw.variant === "string" ? raw.variant : undefined

    models.push({
      key: str(raw.key) || slotKey(providerID, id, variant),
      providerID,
      id,
      variant,
      name: str(raw.name) || id,
      description: str(raw.description),
      family: str(raw.family),
      releaseDate: str(raw.releaseDate),
      knowledge: str(raw.knowledge),
      openWeights: raw.openWeights === true,
      context: num(raw.context),
      maxOutput: num(raw.maxOutput),
      capabilities: capabilities(raw.capabilities),
      pricing: pricing(raw.pricing),
      local: raw.local === true,
      ...(typeof raw.ollamaRank === "number" ? { ollamaRank: raw.ollamaRank } : {}),
      canonicalID: typeof raw.canonicalID === "string" ? raw.canonicalID : null,
      benchmarks: benchmarks(raw.benchmarks),
      scores: scores(raw.scores),
      provenance: provenance(raw.provenance),
      weights: weights(raw.weights),
      cloud: raw.cloud === true,
      reachable: raw.reachable !== false,
      available: true,
      availabilityReason: null,
      cooldownUntil: 0,
    })
  }
  return models
}

/* -------------------------------------------------------------------- query */

/** Requirements a task or agent places on a model. */
export interface Requirements {
  /** Requires text input, i.e. the model can be prompted with text. */
  text?: boolean
  vision?: boolean
  audio?: boolean
  pdf?: boolean
  video?: boolean
  toolCall?: boolean
  structured?: boolean
  reasoning?: boolean
  minContext?: number
  minReasoning?: number
  /** Minimum code strength, 0-10. */
  minCode?: number
  /** Minimum agentic strength, 0-10. */
  minAgentic?: number
  allowLocal?: boolean
  allowUnverified?: boolean
  allowDeprecated?: boolean
  providers?: string[]
  exclude?: string[]
}

/**
 * Does this model satisfy every stated requirement?
 *
 * Estimated rows are included by default and only excluded when the caller
 * asks. With most of the catalogue unbenchmarked, defaulting to verified-only
 * would leave nearly every query empty; the *preference* for verified data
 * belongs in the comparators (`sorts.verifiedFirst`), where it adjusts ranking
 * without removing candidates.
 */
/**
 * Does this model satisfy every stated requirement?
 *
 * Score floors bind only rows whose scores come from a report. For an
 * estimated row the score is a prior derived from price and metadata, so
 * excluding on it would remove most of the catalogue over a guess — a local
 * 30B model is not disqualified from local mode because its derived code score
 * missed a bar set for verified models. Capability and context floors do bind
 * everywhere: those are facts, not estimates.
 */
export function meets(m: CatalogueModel, req: Requirements): boolean {
  if (!m.available) return false
  // An unroutable row is not a candidate for any mode: the running OpenCode
  // holds no credential for its provider, so selecting it would fail on use.
  if (m.reachable === false) return false
  if (m.cooldownUntil > Date.now()) return false
  if (m.provenance.estimated && req.allowUnverified === false) return false
  if (req.allowLocal === false && m.local) return false
  // Text input is a hard floor for anything that drives an agent: a model that
  // cannot be prompted with text cannot do the work, whatever else it does.
  if (req.text === true && !m.capabilities.text) return false
  if (req.vision === true && !m.capabilities.image) return false
  if (req.audio === true && !m.capabilities.audio) return false
  if (req.pdf === true && !m.capabilities.pdf) return false
  if (req.video === true && !m.capabilities.video) return false
  if (req.toolCall === true && !m.capabilities.toolCall) return false
  if (req.structured === true && !m.capabilities.structured) return false
  if (req.reasoning === true && !m.capabilities.reasoning) return false
  if (req.minContext !== undefined && m.context < req.minContext) return false
  if (!m.provenance.estimated) {
    if (req.minReasoning !== undefined && m.scores.reasoning < req.minReasoning) return false
    if (req.minCode !== undefined && m.scores.code < req.minCode) return false
    if (req.minAgentic !== undefined && m.scores.agentic < req.minAgentic) return false
  }
  if (req.providers && !req.providers.includes(m.providerID)) return false
  if (req.exclude?.includes(m.key)) return false
  return true
}

/** Filter to rows meeting the requirements, preserving catalogue order. */
export function filter(cat: Catalogue, req: Requirements): CatalogueModel[] {
  return cat.models.filter((m) => meets(m, req))
}

/** Drop the verification requirement: use when nothing verified qualifies. */
export function filterLoose(cat: Catalogue, req: Requirements): CatalogueModel[] {
  return cat.models.filter((m) => meets(m, { ...req, allowUnverified: true }))
}

/** Sort comparators. Each returns a new array. */
export const sorts = {
  /** Cheapest first; capability breaks ties so a cheap-and-good wins. */
  cheapest: (a: CatalogueModel, b: CatalogueModel) => {
    const pa = blendedPrice(a)
    const pb = blendedPrice(b)
    if (pa !== pb) return pa - pb
    return b.scores.capability - a.scores.capability
  },
  /** Most capable first. */
  capability: (a: CatalogueModel, b: CatalogueModel) => b.scores.capability - a.scores.capability,
  /**
   * Most capable, preferring larger context on a near-tie.
   *
   * The tie window is tight on purpose. A wide window (say ±0.5) collapses a
   * whole tier of models into "equal" and hands the ordering to context, which
   * is then equal too — leaving the ranking arbitrary. Context should only
   * separate models that are genuinely indistinguishable on capability.
   */
  capabilityContext: (a: CatalogueModel, b: CatalogueModel) => {
    const gap = b.scores.capability - a.scores.capability
    if (Math.abs(gap) > 0.05) return gap
    return b.context - a.context
  },
  /** Local first, then capability — used when GPU budget matters. */
  localFirst: (a: CatalogueModel, b: CatalogueModel) => {
    if (a.local !== b.local) return a.local ? -1 : 1
    return b.scores.capability - a.scores.capability
  },
  /** Verified rows first so a strategy prefers reports over estimates. */
  verifiedFirst: (a: CatalogueModel, b: CatalogueModel) => {
    if (a.provenance.estimated !== b.provenance.estimated) return a.provenance.estimated ? 1 : -1
    return b.scores.capability - a.scores.capability
  },
  /** Locally popular first — the community's ranking of local models. */
  popularity: (a: CatalogueModel, b: CatalogueModel) => {
    const ra = a.ollamaRank ?? Number.MAX_SAFE_INTEGER
    const rb = b.ollamaRank ?? Number.MAX_SAFE_INTEGER
    if (ra !== rb) return ra - rb
    return b.scores.capability - a.scores.capability
  },
  /** Highest SWE-bench first — the coding leaderboard. */
  sweBench: (a: CatalogueModel, b: CatalogueModel) => bench(b, "sweBench") - bench(a, "sweBench"),
  /** Highest LMArena Elo first. */
  lmarena: (a: CatalogueModel, b: CatalogueModel) => bench(b, "lmarena") - bench(a, "lmarena"),
}

export function sortBy(models: CatalogueModel[], comparator: (a: CatalogueModel, b: CatalogueModel) => number): CatalogueModel[] {
  return [...models].sort(comparator)
}

function bench(m: CatalogueModel, column: string): number {
  const value = m.benchmarks?.[column]
  return typeof value === "number" ? value : -1
}

/* ------------------------------------------------------------------ pricing */

export function blendedPrice(m: CatalogueModel): number {
  return m.pricing.input + m.pricing.output
}

export function isFree(m: CatalogueModel): boolean {
  return blendedPrice(m) === 0
}

/* -------------------------------------------------------- availability mut */

/** Mark a model unavailable with a reason. Returns the same catalogue. */
export function markUnavailable(cat: Catalogue, key: string, reason: string): Catalogue {
  const model = cat.byKey.get(key)
  if (model) {
    model.available = false
    model.availabilityReason = reason
  }
  return cat
}

/** Restore a model to available. Returns the same catalogue. */
export function markAvailable(cat: Catalogue, key: string): Catalogue {
  const model = cat.byKey.get(key)
  if (model) {
    model.available = true
    model.availabilityReason = null
  }
  return cat
}

/** Put a model on cooldown until `until` (epoch ms). */
export function cooldown(cat: Catalogue, key: string, until: number): Catalogue {
  const model = cat.byKey.get(key)
  if (model) model.cooldownUntil = until
  return cat
}

/** Apply a set of availability patches, e.g. loaded from the state file. */
export function applyAvailability(cat: Catalogue, patches: AvailabilityPatch[]): Catalogue {
  for (const patch of patches) {
    if (patch.available) markAvailable(cat, patch.key)
    else markUnavailable(cat, patch.key, patch.reason ?? "unavailable")
  }
  return cat
}

/** Rows currently usable: available, not on cooldown, requirements met. */
export function availableRows(cat: Catalogue, req: Requirements): CatalogueModel[] {
  return filter(cat, req)
}

/* ------------------------------------------------------------------ display */

/** One compact line describing a model, for status output. */
export function summarize(m: CatalogueModel): string {
  const flags = [
    m.local ? "local" : null,
    m.capabilities.image ? "vision" : null,
    m.capabilities.reasoning ? "reasoning" : null,
    m.capabilities.toolCall ? "tools" : null,
    isFree(m) ? "free" : null,
    m.provenance.estimated ? "estimated" : null,
  ].filter(Boolean)
  const ctx = m.context > 0 ? `${Math.round(m.context / 1000)}k` : "?"
  return `${m.key} · cap ${m.scores.capability} · ctx ${ctx}${flags.length ? ` · ${flags.join(" ")}` : ""}`
}

/** Catalogue summary for the `probe` command. */
export function exportSummary(cat: Catalogue, limit = 12): string {
  const usable = cat.models.filter((m) => m.available && !m.provenance.estimated).length
  const lines = [
    `catalogue: ${cat.models.length} models (${usable} verified-available), generated ${cat.generatedAt || "never"}`,
  ]
  for (const source of cat.sources) {
    lines.push(`  source ${source.id}: ${source.models}`)
  }
  lines.push("  top by capability:")
  for (const m of sortBy(cat.models, sorts.verifiedFirst).slice(0, limit)) {
    lines.push(`    ${m.available ? "✓" : "✗"} ${summarize(m)}`)
  }
  return lines.join("\n")
}

/** A full table dump, for `probe all`. */
export function exportTable(cat: Catalogue, limit = 60): string {
  const rows = [...cat.models]
    .sort((a, b) => b.scores.capability - a.scores.capability)
    .slice(0, limit)
  const header = ["model", "cap", "reason", "code", "agent", "gen", "ctx", "price", "flags"].join(" | ")
  const lines = [header]
  for (const m of rows) {
    const price = isFree(m) ? "free" : `${m.pricing.input}/${m.pricing.output}`
    const flags = [
      m.local ? "L" : "",
      m.capabilities.image ? "V" : "",
      m.provenance.estimated ? "est" : "ver",
    ].join("")
    lines.push(
      [
        m.key,
        m.scores.capability,
        m.scores.reasoning,
        m.scores.code,
        m.scores.agentic,
        m.scores.general,
        m.context > 0 ? `${Math.round(m.context / 1000)}k` : "?",
        price,
        flags,
      ].join(" | "),
    )
  }
  return lines.join("\n")
}

/* -------------------------------------------------------------------- index */

export function index(models: CatalogueModel[], meta: { version: number; generatedAt: string; sources: Catalogue["sources"] }): Catalogue {
  const byKey = new Map<string, CatalogueModel>()
  const byProvider = new Map<string, CatalogueModel[]>()
  const byCanonical = new Map<string, CatalogueModel[]>()

  for (const m of models) {
    byKey.set(m.key, m)
    const bucket = byProvider.get(m.providerID)
    if (bucket) bucket.push(m)
    else byProvider.set(m.providerID, [m])
    if (m.canonicalID) {
      const canon = byCanonical.get(m.canonicalID)
      if (canon) canon.push(m)
      else byCanonical.set(m.canonicalID, [m])
    }
  }

  return { ...meta, models, byKey, byProvider, byCanonical }
}

/* ------------------------------------------------------------------ helpers */

function weights(value: unknown): Weights {
  const record = (value ?? {}) as Record<string, unknown>
  const total = record.total
  const active = record.active
  const source = record.source
  return {
    total: typeof total === "number" ? total : null,
    active: typeof active === "number" ? active : null,
    moe: record.moe === true,
    source:
      source === "tag" || source === "description" || source === "description-active" || source === "registry"
        ? source
        : "unknown",
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function capabilities(value: unknown): Capabilities {
  const record = (value ?? {}) as Record<string, unknown>
  return {
    text: record.text === true,
    image: record.image === true,
    audio: record.audio === true,
    pdf: record.pdf === true,
    video: record.video === true,
    reasoning: record.reasoning === true,
    toolCall: record.toolCall === true,
    structured: record.structured === true,
    embedding: record.embedding === true,
  }
}

function pricing(value: unknown): Pricing {
  const record = (value ?? {}) as Record<string, unknown>
  return {
    input: num(record.input),
    output: num(record.output),
    cacheRead: num(record.cacheRead),
    cacheWrite: num(record.cacheWrite),
  }
}

function scores(value: unknown): Scores {
  const record = (value ?? {}) as Record<string, unknown>
  return {
    reasoning: num(record.reasoning),
    code: num(record.code),
    agentic: num(record.agentic),
    general: num(record.general),
    capability: num(record.capability),
  }
}

function provenance(value: unknown): Provenance {
  const record = (value ?? {}) as Record<string, unknown>
  const metadata = record.metadata
  return {
    metadata: metadata === "models.dev" || metadata === "ollama" || metadata === "local" ? metadata : "models.dev",
    benchmark: typeof record.benchmark === "string" ? record.benchmark : null,
    estimated: record.estimated === true,
    estimatedFields: Array.isArray(record.estimatedFields) ? (record.estimatedFields as string[]) : [],
  }
}

function benchmarks(value: unknown): Record<string, number | string> | null {
  if (!value || typeof value !== "object") return null
  return value as Record<string, number | string>
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}
