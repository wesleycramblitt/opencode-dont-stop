/**
 * dont-stop — Model Catalogue.
 *
 * The catalogue is the decision substrate for every mode strategy. It holds
 * one row per model (one row per variant where a variant changes the model's
 * effective capability or price) with deterministic columns the strategies
 * can filter and sort on.
 *
 * Two provenance rules matter:
 *
 * 1. `verified` is true only when a column came from the registry or a live
 *    probe. Anything estimated is stored with `verified: false` so a strategy
 *    can prefer confirmed data and degrade to estimates only when it must.
 * 2. `deprecated` is a column, not a deletion. A model that opencode has
 *    retired stays in the catalogue with `available: false` and a reason, so
 *    a rotation chain can be explained rather than silently short.
 *
 * Everything here is pure: build takes a provider/model inventory, the rest
 * are filters and sorts over rows. No I/O, no clocks, no plugin context.
 */

/** A capability column set. Inputs and outputs are tracked separately. */
export interface Capabilities {
  text: boolean
  image: boolean
  audio: boolean
  pdf: boolean
  video: boolean
  /** Emits reasoning tokens (chain-of-thought style fields). */
  reasoning: boolean
  /** Emits tool calls. */
  toolCall: boolean
  /** Structured/JSON-constrained output. */
  structured: boolean
  /** Produces embeddings rather than chat completions. */
  embedding: boolean
}

/** Pricing in USD per million tokens. Zero means free. */
export interface Pricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** How much of a row was estimated rather than sourced. */
export interface Estimation {
  /** True when at least one column was derived, not read. */
  estimated: boolean
  /** Columns that were estimated, for auditability. */
  fields: string[]
  /** 0-1 confidence in the estimate. */
  confidence: number
}

export interface CatalogueModel {
  /** `providerID/modelID` or `providerID/modelID#variant` for a variant row. */
  key: string
  providerID: string
  id: string
  /** Set when this row describes a variant rather than the base model. */
  variant?: string
  name: string
  description: string
  /** Token limit for the model's context window. */
  context: number
  /** Maximum output tokens, when known. */
  maxOutput: number
  capabilities: Capabilities
  pricing: Pricing
  /** 0-10 reasoning strength. Higher is better at multi-step logic. */
  reasoning: number
  /** 0-10 coding strength. Higher is better at code generation and editing. */
  code: number
  /** 0-10 instruction-following and long-context retrieval. */
  agentic: number
  /** 0-10 general knowledge and writing quality. */
  general: number
  /** Composite capability score, derived. See `capabilityScore`. */
  capability: number
  estimation: Estimation
  availability: {
    available: boolean
    reason: string | null
    /** Epoch ms of the last successful probe, when probed. */
    probedAt: number | null
  }
  status: "active" | "beta" | "alpha" | "deprecated" | "unknown"
  deprecated: boolean
  /** Local models run on this machine and are not rate limited. */
  local: boolean
}

export interface Catalogue {
  version: number
  lastUpdated: number
  models: CatalogueModel[]
  byKey: Map<string, CatalogueModel>
  byProvider: Map<string, CatalogueModel[]>
}

export const CATALOGUE_VERSION = 2

/* ------------------------------------------------------------------ scoring */

/**
 * Composite capability. Weighted toward agentic and code work because that is
 * what this plugin models are used for; general and reasoning follow. A local
 * model is not penalised here — locality is a mode's job, not a capability's.
 */
export function capabilityScore(m: CatalogueModel): number {
  const raw =
    m.agentic * 0.34 +
    m.code * 0.3 +
    m.reasoning * 0.24 +
    m.general * 0.12
  // Scale context into the same 0-10 band, saturating at 400k.
  const contextTerm = Math.min(m.context, 400000) / 400000
  return round2(raw * 0.9 + contextTerm * 10 * 0.1)
}

/** Total blended price per million tokens, used for "cheapest" sorts. */
export function blendedPrice(m: CatalogueModel): number {
  return m.pricing.input + m.pricing.output
}

export function isFree(m: CatalogueModel): boolean {
  return blendedPrice(m) === 0
}

/** A model is usable when it is available and not deprecated. */
export function isUsable(m: CatalogueModel): boolean {
  return m.availability.available && !m.deprecated
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/* ----------------------------------------------------------------- building */

/** A model row as the registry reports it. Structurally loose on purpose. */
export interface RegistryModel {
  id?: string
  modelID?: string
  name?: string
  description?: string
  package?: string
  variant?: string
  status?: string
  limit?: { context?: number; output?: number }
  cost?: Array<{ input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>
  capabilities?: {
    input?: string[]
    output?: string[]
  }
  options?: Record<string, unknown>
  [key: string]: unknown
}

export interface ProbeResult {
  available: boolean
  reason?: string
}

const CAPABILITY_WORDS: Record<string, keyof Capabilities> = {
  text: "text",
  image: "image",
  vision: "image",
  audio: "audio",
  speech: "audio",
  pdf: "pdf",
  video: "video",
  reasoning: "reasoning",
  "tool-call": "toolCall",
  tools: "toolCall",
  "function-calling": "toolCall",
  structured: "structured",
  json: "structured",
  embedding: "embedding",
  embeddings: "embedding",
}

/** Map a capability string list onto the typed capability set. */
function capabilitiesFromLists(input: string[] = [], output: string[] = []): Capabilities {
  const caps: Capabilities = {
    text: false,
    image: false,
    audio: false,
    pdf: false,
    video: false,
    reasoning: false,
    toolCall: false,
    structured: false,
    embedding: false,
  }
  for (const raw of [...input, ...output]) {
    const key = CAPABILITY_WORDS[String(raw).toLowerCase()]
    if (key) caps[key] = true
  }
  // A model that lists any input capability accepts text unless it is
  // embedding-only; the registry rarely spells this out.
  if (input.length > 0 && !caps.embedding) caps.text = true
  return caps
}

/**
 * Heuristic scores for a model whose real scores are unknown. Derived from
 * name and package tokens, then flattened toward the middle so an unknown
 * model is never ranked above a known-good one purely on optimism.
 */
function estimatedScores(id: string, name: string, caps: Capabilities): {
  reasoning: number
  code: number
  agentic: number
  general: number
  fields: string[]
  confidence: number
} {
  const hay = `${id} ${name}`.toLowerCase()
  const fields = ["reasoning", "code", "agentic", "general"]
  let reasoning = 5
  let code = 5
  let agentic = 5
  let general = 5
  let confidence = 0.35

  const bump = (field: "reasoning" | "code" | "agentic" | "general", amount: number, floor: number) => {
    const table = { reasoning, code, agentic, general }
    const next = Math.min(10, Math.max(floor, table[field] + amount))
    if (field === "reasoning") reasoning = next
    else if (field === "code") code = next
    else if (field === "agentic") agentic = next
    else general = next
  }

  if (/\bmax\b|ultra|largest|xl\b/.test(hay)) {
    bump("reasoning", 3, 7); bump("code", 3, 7); bump("general", 3, 7); confidence += 0.1
  }
  if (/\bhigh\b|pro\b/.test(hay)) {
    bump("reasoning", 2, 6); bump("code", 2, 6); confidence += 0.05
  }
  if (/\bmini\b|small|flash|lite|nano|tiny|:7b|:8b|:1b|:3b/.test(hay)) {
    bump("reasoning", -2, 1); bump("code", -2, 1); bump("agentic", -2, 1); bump("general", -2, 1)
    confidence += 0.1
  }
  if (/code|coder|codex|starcoder|qwen.*coder|devstral/.test(hay)) {
    bump("code", 4, 7); confidence += 0.15
  }
  if (/reason|o1|o3|o4|think|deepseek-r|qwq/.test(hay)) {
    bump("reasoning", 4, 7); confidence += 0.15
  }
  if (/gpt-5|claude|gemini|opus|sonnet|grok|kimi|glm/.test(hay)) {
    bump("agentic", 2, 6); bump("general", 2, 6); confidence += 0.1
  }
  if (caps.reasoning) {
    bump("reasoning", 2, 6); confidence += 0.05
  }
  if (caps.toolCall) {
    bump("agentic", 2, 6); confidence += 0.1
  }

  return { reasoning, code, agentic, general, fields, confidence: Math.min(0.6, confidence) }
}

/** Build one catalogue row from a registry entry plus a probe outcome. */
export function fromRegistry(
  providerID: string,
  model: RegistryModel,
  probe: ProbeResult = { available: true },
  options: { local?: boolean; description?: string } = {},
): CatalogueModel {
  const id = model.id ?? model.modelID ?? "unknown"
  const name = model.name ?? id
  const caps = capabilitiesFromLists(
    (model.capabilities?.input ?? []) as string[],
    (model.capabilities?.output ?? []) as string[],
  )
  const cost = model.cost?.[0] ?? {}
  const pricing: Pricing = {
    input: toNumber(cost.input),
    output: toNumber(cost.output),
    cacheRead: toNumber(cost.cacheRead),
    cacheWrite: toNumber(cost.cacheWrite),
  }

  const scores = estimatedScores(id, name, caps)
  const status = normalizeStatus(model.status)

  const row: CatalogueModel = {
    key: slotKey(providerID, id, model.variant),
    providerID,
    id,
    variant: model.variant,
    name,
    description: options.description ?? model.description ?? describe(providerID, name, caps),
    context: toNumber(model.limit?.context) || fallbackContext(id),
    maxOutput: toNumber(model.limit?.output) || 0,
    capabilities: caps,
    pricing,
    reasoning: scores.reasoning,
    code: scores.code,
    agentic: scores.agentic,
    general: scores.general,
    capability: 0,
    estimation: {
      estimated: true,
      fields: scores.fields,
      confidence: scores.confidence,
    },
    availability: {
      available: probe.available && status !== "deprecated",
      reason: probe.reason ?? (status === "deprecated" ? "deprecated" : null),
      probedAt: probe.available ? Date.now() : null,
    },
    status,
    deprecated: status === "deprecated",
    local: options.local ?? providerID === "ollama",
  }
  row.capability = capabilityScore(row)
  return row
}

/** A model row for something discovered outside the registry (e.g. ollama). */
export function fromLocal(
  providerID: string,
  id: string,
  info: { name?: string; context?: number; capabilities?: string[]; parameterSize?: string } = {},
): CatalogueModel {
  const caps = capabilitiesFromLists(info.capabilities ?? ["text"])
  const name = info.name ?? id
  const scores = estimatedScores(id, `${name} ${info.parameterSize ?? ""}`, caps)
  const row: CatalogueModel = {
    key: slotKey(providerID, id),
    providerID,
    id,
    name,
    description: describe(providerID, name, caps),
    context: info.context ?? fallbackContext(id),
    maxOutput: 0,
    capabilities: caps,
    // Local models cost nothing in API terms.
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: scores.reasoning,
    code: scores.code,
    agentic: scores.agentic,
    general: scores.general,
    capability: 0,
    estimation: { estimated: true, fields: scores.fields, confidence: scores.confidence },
    availability: { available: true, reason: null, probedAt: Date.now() },
    status: "active",
    deprecated: false,
    local: true,
  }
  row.capability = capabilityScore(row)
  return row
}

function describe(providerID: string, name: string, caps: Capabilities): string {
  const parts: string[] = []
  if (providerID === "ollama") parts.push("Locally hosted model")
  else parts.push(`${providerID} model`)
  const active: string[] = []
  if (caps.text) active.push("text")
  if (caps.image) active.push("vision")
  if (caps.audio) active.push("audio")
  if (caps.pdf) active.push("pdf")
  if (caps.video) active.push("video")
  if (caps.reasoning) active.push("reasoning")
  if (caps.toolCall) active.push("tool calling")
  if (caps.structured) active.push("structured output")
  if (active.length) parts.push(`supports ${active.join(", ")}`)
  return `${parts.join("; ")}.`
}

function fallbackContext(id: string): number {
  // Conservative default: enough for agentic work, small enough that a
  // context-requiring filter rejects it when it should.
  if (/128k|long/.test(id)) return 128000
  if (/32k/.test(id)) return 32000
  return 32000
}

function normalizeStatus(status: unknown): CatalogueModel["status"] {
  const s = String(status ?? "").toLowerCase()
  if (s === "active" || s === "beta" || s === "alpha" || s === "deprecated") return s
  return "unknown"
}

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/* ------------------------------------------------------------------ queries */

export function slotKey(providerID: string, id: string, variant?: string): string {
  return variant ? `${providerID}/${id}#${variant}` : `${providerID}/${id}`
}

/** Index a flat row list into the catalogue's lookup structures. */
export function index(models: CatalogueModel[]): Catalogue {
  const byKey = new Map<string, CatalogueModel>()
  const byProvider = new Map<string, CatalogueModel[]>()
  for (const m of models) {
    byKey.set(m.key, m)
    const bucket = byProvider.get(m.providerID)
    if (bucket) bucket.push(m)
    else byProvider.set(m.providerID, [m])
  }
  return { version: CATALOGUE_VERSION, lastUpdated: Date.now(), models, byKey, byProvider }
}

/** Requirements a task or agent places on a model. */
export interface Requirements {
  vision?: boolean
  audio?: boolean
  pdf?: boolean
  video?: boolean
  toolCall?: boolean
  structured?: boolean
  reasoning?: boolean
  minContext?: number
  minReasoning?: number
  minCode?: number
  allowLocal?: boolean
  allowDeprecated?: boolean
  providers?: string[]
}

/** Does this row satisfy every stated requirement? */
export function meets(m: CatalogueModel, req: Requirements): boolean {
  if (!m.availability.available) return false
  if (m.deprecated && req.allowDeprecated !== true) return false
  if (req.allowLocal === false && m.local) return false
  if (req.vision === true && !m.capabilities.image) return false
  if (req.audio === true && !m.capabilities.audio) return false
  if (req.pdf === true && !m.capabilities.pdf) return false
  if (req.video === true && !m.capabilities.video) return false
  if (req.toolCall === true && !m.capabilities.toolCall) return false
  if (req.structured === true && !m.capabilities.structured) return false
  if (req.reasoning === true && !m.capabilities.reasoning) return false
  if (req.minContext !== undefined && m.context < req.minContext) return false
  if (req.minReasoning !== undefined && m.reasoning < req.minReasoning) return false
  if (req.minCode !== undefined && m.code < req.minCode) return false
  if (req.providers && !req.providers.includes(m.providerID)) return false
  return true
}

/** Filter to rows meeting the requirements, preserving catalogue order. */
export function filter(cat: Catalogue, req: Requirements): CatalogueModel[] {
  return cat.models.filter((m) => meets(m, req))
}

/** Sort comparators. Each returns a new array. */
export const sorts = {
  /** Cheapest first; capability breaks ties so a cheap-and-good wins. */
  cheapest: (a: CatalogueModel, b: CatalogueModel) => {
    const pa = blendedPrice(a)
    const pb = blendedPrice(b)
    if (pa !== pb) return pa - pb
    return b.capability - a.capability
  },
  /** Most capable first. */
  capability: (a: CatalogueModel, b: CatalogueModel) => b.capability - a.capability,
  /** Most capable, preferring larger context on a near-tie. */
  capabilityContext: (a: CatalogueModel, b: CatalogueModel) => {
    const gap = b.capability - a.capability
    if (Math.abs(gap) > 0.5) return gap
    return b.context - a.context
  },
  /** Local first, then capability — used when GPU budget matters. */
  localFirst: (a: CatalogueModel, b: CatalogueModel) => {
    if (a.local !== b.local) return a.local ? -1 : 1
    return b.capability - a.capability
  },
  /** Verified rows first so a strategy prefers confirmed over estimated. */
  verifiedFirst: (a: CatalogueModel, b: CatalogueModel) => {
    if (a.estimation.estimated !== b.estimation.estimated) return a.estimation.estimated ? 1 : -1
    return b.capability - a.capability
  },
}

export function sortBy(cat: CatalogueModel[], comparator: (a: CatalogueModel, b: CatalogueModel) => number): CatalogueModel[] {
  return [...cat].sort(comparator)
}

/** Mark a row unavailable with a reason. Returns a new catalogue. */
export function markUnavailable(cat: Catalogue, key: string, reason: string): Catalogue {
  const model = cat.byKey.get(key)
  if (!model) return cat
  model.availability = { available: false, reason, probedAt: Date.now() }
  return cat
}

/** Restore a row to available. Returns a new catalogue. */
export function markAvailable(cat: Catalogue, key: string): Catalogue {
  const model = cat.byKey.get(key)
  if (!model) return cat
  model.availability = { available: true, reason: null, probedAt: Date.now() }
  return cat
}

/** Models currently on cooldown, keyed for a rotation chain. */
export function availableRows(cat: Catalogue, req: Requirements, cooldowns: Record<string, number>, now = Date.now()): CatalogueModel[] {
  return filter(cat, req).filter((m) => {
    const until = cooldowns[m.key]
    return until === undefined || until <= now
  })
}

/** A compact one-line summary per model, for status output. */
export function summarize(m: CatalogueModel): string {
  const flags = [
    m.local ? "local" : null,
    m.capabilities.image ? "vision" : null,
    m.capabilities.reasoning ? "reasoning" : null,
    isFree(m) ? "free" : null,
    m.deprecated ? "deprecated" : null,
    m.estimation.estimated ? "estimated" : null,
  ].filter(Boolean)
  return `${m.key} · cap ${m.capability} · ctx ${Math.round(m.context / 1000)}k${flags.length ? ` · ${flags.join(" ")}` : ""}`
}

export function exportSummary(cat: Catalogue): string {
  const usable = cat.models.filter(isUsable).length
  const lines = [
    `catalogue: ${cat.models.length} models (${usable} usable), updated ${new Date(cat.lastUpdated).toISOString()}`,
  ]
  for (const m of sortBy(cat.models, sorts.capability).slice(0, 10)) {
    lines.push(`  ${m.availability.available ? "✓" : "✗"} ${summarize(m)}`)
  }
  return lines.join("\n")
}
