/**
 * Catalogue fetch.
 *
 * Builds the catalogue by querying live sources and joining them against the
 * curated benchmark table. Everything here is I/O; the catalogue shape and all
 * ranking live in `lib/catalogue.ts`.
 *
 * Sources:
 *
 * - **models.dev** (`https://models.dev/api.json`) — the authoritative model
 *   registry: capabilities, modalities, context and output limits, pricing,
 *   knowledge cutoff, release date, and the `canonical_model_id` that links
 *   every provider alias of a model to one identity. This is the backbone.
 * - **ollama.com search** — the top N locally-runnable models by popularity,
 *   with descriptions and parameter tags.
 * - **local ollama** (`/api/tags`) — what is actually installed here.
 *
 * The output is written to `data/catalogue.json`, which is checked in. That
 * matters: the catalogue is then reproducible, reviewable in a diff, and does
 * not require network access at plugin load time.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { benchmarksFor, type Benchmarks } from "../data/benchmarks.ts"
import { FREE_TIERS } from "../data/free-tiers.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
export const CATALOGUE_FILE = join(HERE, "..", "data", "catalogue.json")

/**
 * How old the persisted catalogue may be before a heartbeat refreshes it (24h).
 *
 * The owner asked (2026-10-12) for the catalogue to look after itself — new
 * free rows, price changes, retirements — instead of waiting for a manual
 * `update-model-catalogue`. Alibaba's inventory is the one source a refresh
 * does not improve without a key; everything else (models.dev, ollama, the
 * free-tier fold) is picked up on the cadence. The file's own mtime is the
 * clock: a successful refresh rewrites it, so the check needs no extra state.
 */
export const CATALOGUE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Whether the persisted catalogue predates the refresh window. Missing = due. */
export function catalogueRefreshDue(
  file: string,
  now: number = Date.now(),
  intervalMs: number = CATALOGUE_REFRESH_INTERVAL_MS,
): boolean {
  try {
    return now - statSync(file).mtimeMs > intervalMs
  } catch {
    return true
  }
}

export const MODELS_DEV_URL = "https://models.dev/api.json"
export const OLLAMA_SEARCH_URL = "https://ollama.com/search?o=popular&c=text"
export const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags"

/**
 * Alibaba Model Studio's live model inventory.
 *
 * The Model Studio models API returns the full catalogue for the account
 * behind the key — id, name, description, features, per-model prices, context
 * window, input/output modalities — which is strictly more current than the
 * models.dev snapshot (it lists models models.dev has not caught up with). It
 * is paginated: `page_no` × `page_size` against `output.total`.
 *
 * Override the host with `ALIBABA_MODELS_URL` when the account is a dedicated
 * workspace (`https://ws-<id>.<region>.maas.aliyuncs.com/api/v1/models`); the
 * default is the international Model Studio endpoint so no configuration is
 * needed for the common case.
 */
export const ALIBABA_MODELS_URL =
  process.env.ALIBABA_MODELS_URL ?? "https://dashscope-intl.aliyuncs.com/api/v1/models"
const ALIBABA_PAGE_SIZE = 100

/**
 * Whether the Alibaba Model Studio source is in play at all.
 *
 * The inventory smoke-tested green on 2026-10-11 (`qwen3.7-flash`,
 * `qwen3.5-flash`, `deepseek-v4-flash-0731` all answered), and its quota-backed
 * rows are legitimate `free`-mode candidates: the per-model console allowance
 * is declared data in `data/free-tiers.ts`, not price, so it counts as a free
 * sweep member — see `FreeTier` in `lib/catalogue.ts`. `DONT_STOP_ALIBABA=0`
 * turns the whole source off without an edit; `=1` is the default.
 */
const ENV_OVERRIDE = process.env.DONT_STOP_ALIBABA
export const ALIBABA_ENABLED = ENV_OVERRIDE === undefined ? true : ENV_OVERRIDE !== "0"

/** How many popular ollama models to include. */
export const TOP_OLLAMA = 100

/* ------------------------------------------------------------- raw sources */

interface FetchOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Skip the local ollama probe (used when testing). */
  skipLocal?: boolean
  /** Alibaba key override, ahead of env and config resolution. */
  alibabaKey?: string
  /**
   * Read reachability from the `opencode` CLI subprocess.
   *
   * Default true — correct for the standalone update script. A caller running
   * *inside* a live opencode server must pass false: the subprocess call is
   * `execFileSync`, which blocks the server's event loop, and the CLI needs
   * that same server to answer — the deadlock that made the server
   * "unresponsive" and got it restarted by the CLI's own recovery. In-server
   * reachability is re-derived from `ctx.model.list()` instead.
   */
  registry?: boolean
}

async function getJSON(url: string, options: FetchOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
    headers: { accept: "application/json" },
  })
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  return response.json()
}

async function getText(url: string, options: FetchOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
    headers: {
      accept: "text/html",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  })
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  return response.text()
}

/* ------------------------------------------------------- models.dev shaping */

interface ModelsDevModel {
  id: string
  name: string
  description?: string
  family?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  structured_output?: boolean
  open_weights?: boolean
  knowledge?: string
  release_date?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  canonical_model_id?: string
  status?: string
}

interface ModelsDevProvider {
  id: string
  name?: string
  models: Record<string, ModelsDevModel>
}

/** Which providers to import, in priority order. */
export const PROVIDERS = ["opencode", "opencode-go", "zenmux", "ollama-cloud", "anthropic", "openai", "google", "deepseek", "moonshotai", "alibaba", "zai-org", "qwen", "meta-llama", "mistralai", "minimaxai", "xai"]

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

interface RawRow {
  providerID: string
  id: string
  name: string
  description: string
  family: string
  releaseDate: string
  knowledge: string
  openWeights: boolean
  context: number
  maxOutput: number
  capabilities: Record<string, boolean>
  pricing: { input: number; output: number; cacheRead: number; cacheWrite: number }
  canonicalID: string | null
  local: boolean
  source: "models.dev" | "ollama" | "local" | "alibaba"
  /** Popularity position among local models, when known. */
  rank?: number
  /**
   * Parameter counts, split because they answer different questions.
   *
   * `total` is what must be held in memory, so it governs VRAM feasibility.
   * `active` is what runs per token, so it governs effective capability. For a
   * dense model the two are equal; for a mixture-of-experts model they differ
   * by an order of magnitude — nemotron-3.5-lightning is 30B total with 3B
   * active — and conflating them makes both estimates wrong.
   */
  weights?: Weights
  /** True when the provider hosts this model remotely rather than locally. */
  cloud?: boolean
  /** Set when this row describes a variant rather than the base model. */
  variant?: string
  /** Scratch: the running server cannot route to this row. */
  unroutable?: boolean
}

/** Parameter counts in billions, with provenance. */
export interface Weights {
  /** Total parameters loaded into memory, in billions. */
  total: number | null
  /** Parameters active per forward pass, in billions. */
  active: number | null
  /** True when total and active differ, i.e. a mixture-of-experts model. */
  moe: boolean
  /** Where the numbers came from. */
  source: "tag" | "description" | "description-active" | "registry" | "unknown"
}

export const UNKNOWN_WEIGHTS: Weights = {
  total: null,
  active: null,
  moe: false,
  source: "unknown",
}

/**
 * Which raw source wins when two rows share a key. Higher wins; ties keep the
 * first row. The local daemon is ground truth for what runs here; a vendor's
 * own inventory beats a third-party registry's snapshot of it; the registry
 * beats a scrape.
 */
const SOURCE_PRIORITY: Record<RawRow["source"], number> = {
  local: 3,
  alibaba: 2,
  "models.dev": 1,
  ollama: 0,
}

/** Flatten models.dev into raw rows for the requested providers. */
function rowsFromModelsDev(payload: unknown): RawRow[] {
  const providers = payload as Record<string, ModelsDevProvider>
  const rows: RawRow[] = []

  for (const providerID of PROVIDERS) {
    const provider = providers?.[providerID]
    if (!provider?.models) continue

    for (const model of Object.values(provider.models)) {
      const input = model.modalities?.input ?? []
      const output = model.modalities?.output ?? []
      rows.push({
        providerID,
        id: model.id,
        name: model.name || model.id,
        description: model.description ?? "",
        family: model.family ?? "",
        releaseDate: model.release_date ?? "",
        knowledge: model.knowledge ?? "",
        openWeights: model.open_weights === true,
        context: num(model.limit?.context),
        maxOutput: num(model.limit?.output),
        capabilities: {
          // `text` means the model accepts text *input*, which is what makes
          // it usable as a chat or agent model. An ASR model takes audio and
          // emits text; a TTS model takes text and emits audio. Neither can
          // drive a coding agent, and OR-ing input with output would mark
          // both as text-capable and let them into every pool.
          text: input.includes("text"),
          image: model.attachment === true || input.includes("image"),
          audio: input.includes("audio"),
          pdf: input.includes("pdf"),
          video: input.includes("video"),
          reasoning: model.reasoning === true,
          toolCall: model.tool_call === true,
          structured: model.structured_output === true,
          embedding: input.includes("embedding") || output.includes("embedding"),
        },
        pricing: {
          input: num(model.cost?.input),
          output: num(model.cost?.output),
          cacheRead: num(model.cost?.cache_read),
          cacheWrite: num(model.cost?.cache_write),
        },
        canonicalID: model.canonical_model_id ?? null,
        // `ollama` (the scrape) and the local daemon are local. `ollama-cloud`
        // is a *remote paid* API that happens to be hosted by Ollama, so it
        // must not claim locality: local mode would otherwise select a paid
        // cloud model over the model actually installed on this machine.
        local: false,
        // models.dev publishes capabilities and limits but no parameter
        // counts, so weights stay unknown rather than guessed.
        weights: UNKNOWN_WEIGHTS,
        cloud: true,
        source: "models.dev",
      })
    }
  }
  return rows
}

/* --------------------------------------------------------- ollama shaping */

/** Pull model names out of the ollama search page, in popularity order. */
export function parseOllamaSearch(html: string, limit = TOP_OLLAMA): Array<{ name: string; rank: number }> {
  const seen = new Set<string>()
  const out: Array<{ name: string; rank: number }> = []

  for (const match of html.matchAll(/href="\/library\/([^"?/#]+)"/g)) {
    const name = decodeURIComponent(match[1])
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, rank: out.length + 1 })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Pull context and parameter size out of a search list item.
 *
 * The tags row looks like `tools  decision  thinking  0.8b  4b  81K`, where the
 * `K`/`M`-suffixed numbers are context windows and the `b`-suffixed ones are
 * parameter counts. The context is the *largest* K/M value, since a model
 * reports its longest context configuration there.
 */
function tagsFromSearchItem(item: string): { context: number; parameterSize?: string } {
  const text = item.replace(/<[^>]+>/g, " ")
  const decoded = text
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")

  const contextTokens = decoded.match(/\b(\d+(?:\.\d+)?)([KM])\b/g) ?? []
  let context = 0
  for (const token of contextTokens) {
    const match = /(\d+(?:\.\d+)?)([KM])/.exec(token)
    if (!match) continue
    const value = Number.parseFloat(match[1])
    const tokens = match[2] === "M" ? value * 1_000_000 : value * 1_000
    if (tokens > context) context = tokens
  }

  const sizeMatch = /\b(\d+(?:\.\d+)?)\s*b\b/i.exec(decoded)
  return {
    context,
    parameterSize: sizeMatch ? `${sizeMatch[1]}B` : undefined,
  }
}


/**
 * Which (providerID, modelID) pairs the running OpenCode can route to.
 *
 * Queried through the `opencode api` CLI rather than HTTP because the server
 * requires authentication: a plain fetch to its port returns 401, and the CLI
 * already carries the credentials. The server picks an ephemeral port per run,
 * so discovery is the CLI's job too.
 *
 * Call this only from a process that is NOT the opencode server. The call is
 * `execFileSync` — it blocks the caller's event loop — and the CLI it spawns
 * must talk back to the server to answer, so running it inside the server is
 * a self-deadlock: the server cannot serve the CLI while it waits for it, the
 * CLI declares the background service unresponsive and restarts it, and the
 * work in flight dies. `fetchCatalogue({ registry: false })` is the in-server
 * path; the engine re-derives reachability in-process.
 *
 * Returns null when the server cannot be reached, which means "unknown" rather
 * than "unreachable" — a fetch run away from a live server must not mark
 * everything unroutable and empty every mode.
 */
export function reachableModels(): Set<string> | null {
  try {
    // Imported rather than `require`d: this module is ESM, and `require` is
    // undefined there — using it silently returns null and quietly marks the
    // whole catalogue unreachable-checked.
    const stdout = execFileSync("opencode", ["api", "get", "/api/model"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const payload = JSON.parse(stdout) as { data?: Array<{ providerID?: string; id?: string }> }
    if (!Array.isArray(payload.data)) return null
    const keys = new Set<string>()
    for (const model of payload.data) {
      if (model.providerID && model.id) keys.add(`${model.providerID}/${model.id}`)
    }
    return keys.size > 0 ? keys : null
  } catch {
    return null
  }
}
function defaultCapabilities(): Record<string, boolean> {
  return {
    text: true,
    image: false,
    audio: false,
    pdf: false,
    video: false,
    reasoning: false,
    toolCall: false,
    structured: false,
    embedding: false,
  }
}

/**
 * Parse parameter counts out of prose and tag rows.
 *
 * A tag row reads `tools thinking 0.8b 4b 81K`; a description reads "an open
 * 30B MoE model with 3B active parameters", "activates 52B of 1.05T total
 * parameters", or "30B parameters, licensed under Apache 2.0". Vendors put the
 * MoE split in either order and name the total in several ways, so the shapes
 * are matched explicitly rather than by one guess at a generic pattern.
 *
 * Reliability order, most to least:
 *
 * 1. an explicit **active** figure — the vendor stating what runs per token
 * 2. an explicit **total** figure — "X parameters", "X total", "of X T total"
 * 3. the tag row's size, which usually reports the total
 *
 * `M` units are honoured (421M is 0.421B), and a B/T figure with no stated
 * total is treated as the total rather than dropped, because most dense models
 * report only one number and it is the total.
 */
export function parseWeights(text: string, tags: string[] = []): Weights {
  const hay = `${text} ${tags.join(" ")}`

  /** Convert "1.05T" / "52B" / "421M" into billions. */
  const billions = (value: string, unit: string): number | null => {
    const n = Number.parseFloat(value)
    if (!Number.isFinite(n)) return null
    switch (unit.toUpperCase()) {
      case "T":
        return n * 1000
      case "B":
        return n
      case "M":
        return n / 1000
      default:
        return null
    }
  }

  const first = (pattern: RegExp): number | null => {
    const m = pattern.exec(hay)
    return m ? billions(m[1], m[2]) : null
  }

  // Active: "activates 52B", "with 3B active parameters", "3B activated".
  const active =
    first(/(?:activates?|activates|with|has)\s+(\d+(?:\.\d+)?)\s*([BTM])\b/i) ??
    first(/(\d+(?:\.\d+)?)\s*([BTM])\s+(?:parameters?\s+)?(?:activated|active)/i)

  // Total: "1.05T total parameters", "52B total parameters", "30B parameters",
  // "128B weights", or a size stated just before "model"/"MoE".
  const total =
    first(/(\d+(?:\.\d+)?)\s*([BTM])\s+(?:total\s+)?(?:parameters|weights)/i) ??
    first(/of\s+(\d+(?:\.\d+)?)\s*([BTM])\s+total/i) ??
    // A size stated immediately before a noun that means "the model": "an open
    // 30B MoE model", "a 4B decision model", "a 421M decision model", "a 30B
    // mixture-of-experts model". The lookahead keeps this from matching a
    // price or a benchmark figure that happens to sit near the word "model".
    first(/(\d+(?:\.\d+)?)\s*([BTM])\b(?=[^.]{0,40}?\b(?:mixture[- ]of[- ]experts|MoE|model)\b)/i)

  if (active !== null || total !== null) {
    // An MoE model reports both. When only the active figure was stated, the
    // total is at least the active count, and MoE status is unknown rather
    // than false — a dense-looking figure here would understate VRAM.
    const statedTotal = total ?? active
    const statedActive = active ?? total
    const moe = total !== null && active !== null && Math.abs(total - active) > 0.001
    return {
      total: statedTotal,
      active: statedActive,
      moe,
      source: active !== null && total !== null ? "description-active" : "description",
    }
  }

  // Fall back to the tag row's largest B-suffixed number.
  const sized = tags
    .map((t) => /^(\d+(?:\.\d+)?)([bBmM])$/.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => billions(m[1], m[2])!)
    .filter((n) => Number.isFinite(n) && n > 0)
  if (sized.length > 0) {
    const value = Math.max(...sized)
    return { total: value, active: value, moe: false, source: "tag" }
  }

  return UNKNOWN_WEIGHTS
}

/**
 * The popularity table, persisted by `scripts/scrape-ollama.ts`.
 *
 * `ollama.com/search` is client-rendered and caps the server HTML at 20
 * models, so a plain fetch cannot see the rest. The scrape step drives a real
 * browser to collect the full list with context windows and capability tags,
 * then writes it here. Reads are plain file I/O, so the catalogue update never
 * needs a browser.
 */
interface PopularEntry {
  name: string
  context: number
  parameterSize?: string
  capabilities?: string[]
  description?: string
}

interface PopularDocument {
  version: number
  scrapedAt: string
  source: string
  models: PopularEntry[]
}

const POPULAR_FILE = join(HERE, "..", "data", "ollama-popular.json")

/** Read the scraped popularity table, or null when it has not been collected. */
export function readPopularTable(path: string = POPULAR_FILE): PopularDocument | null {
  if (!existsSync(path)) return null
  try {
    const document = JSON.parse(readFileSync(path, "utf8")) as PopularDocument
    if (!Array.isArray(document.models)) return null
    return document
  } catch {
    return null
  }
}

/**
 * Fetch the top ollama models, preferring the scraped popularity table and
 * falling back to the 20-model HTML page when it is absent.
 *
 * Context and capability tags come from the table when it has them; the tags
 * map onto the catalogue's capability columns so a local model's vision or
 * tool-calling support is a fact, not a guess.
 */
async function rowsFromOllamaSearch(options: FetchOptions): Promise<RawRow[]> {
  const popular = readPopularTable()
  if (popular && popular.models.length > 0) {
    return popular.models.map((entry, position) => ({
      providerID: "ollama",
      id: entry.name,
      name: entry.name,
      description: entry.description ?? "",
      family: "",
      releaseDate: "",
      knowledge: "",
      openWeights: true,
      context: entry.context ?? 0,
      maxOutput: 0,
      capabilities: capabilitiesFromOllamaTags(entry.capabilities ?? []),
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      canonicalID: null,
      local: true,
      source: "ollama",
      rank: position + 1,
      weights: parseWeights(entry.description ?? "", entry.parameterSize ? [entry.parameterSize] : []),
      // ollama.com tags a model `cloud` when it runs on Ollama's servers
      // rather than on the user's machine. That is the difference between a
      // local model and a rented one, and it must survive into the catalogue.
      cloud: (entry.capabilities ?? []).includes("cloud"),
    }))
  }

  // Fallback: the HTML page only carries the first 20, which is still useful
  // when no scrape has been run yet.
  try {
    const html = await getText(OLLAMA_SEARCH_URL, options)
    const items = html.split(/<li[\s>]/).slice(1)
    const entries = parseOllamaSearch(html, TOP_OLLAMA)
    return entries.map((entry, position) => {
      const tags = tagsFromSearchItem(items[position] ?? "")
      return {
        providerID: "ollama",
        id: entry.name,
        name: entry.name,
        description: "",
        family: "",
        releaseDate: "",
        knowledge: "",
        openWeights: true,
        context: tags.context,
        maxOutput: 0,
        capabilities: defaultCapabilities(),
        pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        canonicalID: null,
        local: true,
        source: "ollama" as const,
        rank: entry.rank,
      }
    })
  } catch (error) {
    console.error(`[catalogue] ollama search failed: ${messageOf(error)}`)
    return []
  }
}

/** Map ollama's search tags onto the catalogue's capability columns. */
function capabilitiesFromOllamaTags(tags: string[]): Record<string, boolean> {
  const set = new Set(tags.map((t) => t.toLowerCase()))
  return {
    text: true,
    image: set.has("vision"),
    audio: set.has("audio"),
    pdf: false,
    video: set.has("video"),
    // A "thinking" tag is ollama's marker for a reasoning-capable model.
    reasoning: set.has("thinking") || set.has("reasoning"),
    toolCall: set.has("tools"),
    structured: set.has("structured"),
    embedding: set.has("embedding"),
  }
}

/** What is actually installed locally, keyed by tag. */
async function localOllama(options: FetchOptions): Promise<Map<string, { context: number; parameterSize?: string }>> {
  if (options.skipLocal) return new Map()
  try {
    const data = (await getJSON(OLLAMA_TAGS_URL, options)) as {
      models?: Array<{ name?: string; model?: string; context_length?: number; parameter_size?: string }>
    }
    const out = new Map<string, { context: number; parameterSize?: string }>()
    for (const model of data.models ?? []) {
      const name = model.name ?? model.model
      if (name) out.set(name, { context: num(model.context_length), parameterSize: model.parameter_size })
    }
    return out
  } catch {
    // No local ollama: the catalogue still lists popular remote-runnable models.
    return new Map()
  }
}

/* -------------------------------------------------------- alibaba shaping */

/** A model entry as the Model Studio inventory reports it. */
export interface AlibabaModelEntry {
  model: string
  name?: string
  description?: string
  provider?: string
  published_time?: string
  features?: string[]
  capabilities?: string[]
  inference_metadata?: {
    request_modality?: string[]
    response_modality?: string[]
  }
  model_info?: {
    context_window?: number | null
    max_output_tokens?: number | null
  }
  prices?: Array<{
    prices?: Array<{
      type?: string
      price?: string | number
      time_band?: string
    }>
  }>
}

/**
 * Resolve the Alibaba credential for the inventory query, in precedence
 * order. One resolution function keeps every caller honest about where the
 * key may come from:
 *
 *   1. an explicit override (tests, `--alibaba-key`)
 *   2. the conventional env names (`ALIBABA_API_KEY`, `DASHSCOPE_API_KEY`)
 *   3. the configured provider block in `opencode.json` (V2 `settings.apiKey`
 *      or legacy `options.apiKey`)
 *
 * Returns null when nothing is configured; the caller then skips the source
 * with a note rather than failing the whole build.
 */
export function resolveAlibabaKey(
  override?: string,
  home: string = process.env.HOME ?? "",
): string | null {
  if (override && override.length > 0) return override
  const fromEnv = process.env.ALIBABA_API_KEY ?? process.env.DASHSCOPE_API_KEY
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return keyFromConfig(home)
}

function keyFromConfig(home: string): string | null {
  const candidates = [
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        providers?: Record<string, { settings?: { apiKey?: unknown }; options?: { apiKey?: unknown } }>
      }
      const provider = parsed.providers?.alibaba
      const key = provider?.settings?.apiKey ?? provider?.options?.apiKey
      if (typeof key === "string" && key.length > 0 && !key.startsWith("{env:")) return key
    } catch {
      // Unreadable config is not a reason to fail the build; env set it above.
    }
  }
  return null
}

/**
 * Parse one inventory payload into model entries. Pure, so it can be tested
 * against a fixture. Handles both the Model Studio shape
 * (`output.models[].model`) and the OpenAI-compatible shape (`data[].id`),
 * which the compatible-mode endpoint returns.
 */
export function parseAlibabaInventory(payload: unknown): AlibabaModelEntry[] {
  const record = (payload ?? {}) as Record<string, unknown>
  const output = record.output as { models?: unknown } | undefined
  const rows = output?.models ?? record.data
  if (!Array.isArray(rows)) return []
  const out: AlibabaModelEntry[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const entry = row as Record<string, unknown>
    const id = typeof entry.model === "string" ? entry.model
      : typeof entry.id === "string" ? entry.id
      : null
    if (!id) continue
    const prices = entry.prices
    const metadata = entry.inference_metadata
    const info = entry.model_info
    const infoObj = info && typeof info === "object" ? info as Record<string, unknown> : null
    out.push({
      model: id,
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
      ...(typeof entry.published_time === "string" ? { published_time: entry.published_time } : {}),
      ...(Array.isArray(entry.features) ? { features: entry.features as string[] } : {}),
      ...(Array.isArray(entry.capabilities) ? { capabilities: entry.capabilities as string[] } : {}),
      ...(metadata && typeof metadata === "object"
        ? { inference_metadata: metadata as AlibabaModelEntry["inference_metadata"] }
        : {}),
      ...(infoObj
        ? { model_info: infoObj as AlibabaModelEntry["model_info"] }
        : {}),
      ...(Array.isArray(prices) ? { prices: prices as AlibabaModelEntry["prices"] } : {}),
    })
  }
  return out
}

/** The token prices for an entry, preferring standard over thinking bands. */
function alibabaPricing(entry: AlibabaModelEntry): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const bands = entry.prices ?? []
  const pick = (preferred: string[], fallback: string[]) => {
    const all = bands.flatMap((band) => band.prices ?? [])
    const found = all.find((p) => preferred.includes(p.type ?? ""))
    const alt = found ? null : all.find((p) => fallback.includes(p.type ?? ""))
    const price = found ?? alt
    return typeof price?.price === "string" || typeof price?.price === "number" ? Number(price.price) : 0
  }
  return {
    input: pick(["input_token", "thinking_input_token"], ["text_input_token", "omni_no_audio_input_token", "omni_input_token"]),
    output: pick(["output_token", "thinking_output_token"], ["text_output_token", "omni_text_output_token", "omni_output_token"]),
    cacheRead: pick(["input_token_cache_read", "thinking_input_token_cache_read"], []),
    cacheWrite: pick(["input_token_cache_creation_5m", "input_token_cache"], []),
  }
}

/** Capabilities from the inventory's feature and modality lists. */
function alibabaCapabilities(entry: AlibabaModelEntry): Record<string, boolean> {
  const tags = new Set((entry.features ?? []).map((f) => f.toLowerCase()))
  const request = new Set((entry.inference_metadata?.request_modality ?? []).map((m) => m.toLowerCase()))
  const capabilities = new Set((entry.capabilities ?? []).map((c) => c.toLowerCase()))
  return {
    text: request.has("text") || capabilities.has("tg"),
    image: request.has("image"),
    audio: request.has("audio"),
    pdf: request.has("pdf"),
    video: request.has("video"),
    reasoning: capabilities.has("reasoning") || capabilities.has("thinking"),
    toolCall: tags.has("function-calling"),
    structured: tags.has("structured-outputs"),
    embedding: tags.has("embedding"),
  }
}

/**
 * The raw rows a Model Studio inventory contributes.
 *
 * Only rows that can drive a chat/agent turn are emitted: a row must accept
 * text input and carry token prices. Image/video generation, TTS, ASR and
 * embedding models have neither (they price per image/character/second), and a
 * row without pricing must never enter the catalogue as if it were free.
 */
export function rowsFromAlibaba(entries: AlibabaModelEntry[]): RawRow[] {
  const rows: RawRow[] = []
  for (const entry of entries) {
    const capabilities = alibabaCapabilities(entry)
    const pricing = alibabaPricing(entry)
    if (!capabilities.text) continue
    if (pricing.input === 0 && pricing.output === 0) continue

    const published = (entry.published_time ?? "").replace(" ", "T")
    rows.push({
      providerID: "alibaba",
      id: entry.model,
      name: entry.name ?? entry.model,
      description: entry.description ?? "",
      family: entry.provider ?? "",
      releaseDate: published,
      knowledge: "",
      openWeights: false,
      context: Number(entry.model_info?.context_window ?? 0),
      maxOutput: Number(entry.model_info?.max_output_tokens ?? 0),
      capabilities,
      pricing,
      canonicalID: null,
      local: false,
      // The inventory is the vendor's own word on its models; a row from it
      // outranks the same key from models.dev.
      source: "alibaba",
      weights: UNKNOWN_WEIGHTS,
      cloud: true,
    })
  }
  return rows
}

/** Fetch the full inventory, paginated. */
async function fetchAlibabaInventory(options: FetchOptions): Promise<AlibabaModelEntry[]> {
  const key = resolveAlibabaKey(options.alibabaKey)
  if (!key) return []
  const fetchImpl = options.fetchImpl ?? fetch
  const entries: AlibabaModelEntry[] = []
  let page = 1
  for (;;) {
    const url = `${ALIBABA_MODELS_URL}${ALIBABA_MODELS_URL.includes("?") ? "&" : "?"}page_no=${page}&page_size=${ALIBABA_PAGE_SIZE}`
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
    })
    if (!response.ok) throw new Error(`${ALIBABA_MODELS_URL} -> HTTP ${response.status}`)
    const payload = (await response.json()) as Record<string, unknown>
    const parsed = parseAlibabaInventory(payload)
    entries.push(...parsed)
    if (parsed.length === 0) break
    const total = numberOf((payload.output as { total?: unknown } | undefined)?.total)
    if (total > 0 && page * ALIBABA_PAGE_SIZE >= total) break
    if (parsed.length < ALIBABA_PAGE_SIZE) break
    page += 1
  }
  return entries
}

function numberOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/* -------------------------------------------------------------------- build */

/** A catalogue row as persisted. Everything here is sourced or derived. */
export interface CatalogueRow {
  key: string
  providerID: string
  id: string
  name: string
  description: string
  family: string
  releaseDate: string
  knowledge: string
  openWeights: boolean
  context: number
  maxOutput: number
  capabilities: Record<string, boolean>
  pricing: { input: number; output: number; cacheRead: number; cacheWrite: number }
  local: boolean
  /** Popularity rank among local ollama models, when known. */
  ollamaRank?: number
  parameterSize?: string
  variant?: string
  /** Parameter counts, split into total (VRAM) and active (capability). */
  weights: Weights
  /** True when a provider hosts this remotely rather than on this machine. */
  cloud: boolean
  /**
   * Whether the running OpenCode can route to this provider. `false` means it
   * cannot, so no mode may select it. See `applyReachability`.
   */
  reachable: boolean
  /** Capability tag list for display, e.g. ["image", "toolCall"]. */
  capabilityTags?: string[]
  canonicalID: string | null
  benchmarks: Benchmarks | null
  /** Strength scores 0-10. From benchmarks when available, else derived. */
  scores: { reasoning: number; code: number; agentic: number; general: number; capability: number }
  /** A declared free allowance, when one is curated for this model. */
  freeTier: { tokens: number; windowDays: number; enabled: boolean; source: string } | null
  provenance: {
    metadata: "models.dev" | "ollama" | "local" | "alibaba"
    benchmark: string | null
    /** True when `scores` was derived rather than read from a report. */
    estimated: boolean
    estimatedFields: string[]
  }
}

export interface CatalogueDocument {
  version: number
  generatedAt: string
  sources: { id: string; url: string; models: number; note?: string }[]
  models: CatalogueRow[]
}

/**
 * Calibrate a benchmark percentage onto the 0-10 score scale.
 *
 * Benchmark values are not uniformly distributed: a good model scores 60-90%
 * on most evals, so a linear `/10` maps the whole useful range into 6-9 and
 * leaves real reports scoring *below* metadata-derived estimates that span
 * 2-10. That inversion is wrong — a published report should outrank a
 * guess — so benchmarks are calibrated against a curve that reflects where
 * the mass actually sits.
 *
 * Anchors are (percent, score) pairs; the curve is piecewise linear between
 * them. A 40% result is genuinely mediocre (4.5), 80% is excellent (8.6), and
 * 95% is near-ceiling (9.6). The scale is shared with the metadata path, so a
 * benchmarked row and a derived row are directly comparable.
 *
 * Known limitation: benchmarks differ in difficulty. SWE-bench 80% is far
 * harder than MATH-500 98%, and this curve does not correct for that. It is a
 * documented, uniform approximation, not a claim that the evals are equivalent.
 */
const BENCHMARK_ANCHORS: Array<[number, number]> = [
  [0, 0],
  [10, 1.5],
  [20, 2.5],
  [30, 3.6],
  [40, 4.5],
  [50, 5.4],
  [60, 6.3],
  [70, 7.3],
  [80, 8.6],
  [90, 9.4],
  [100, 10],
]

export function calibrateBenchmark(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  const clamped = Math.max(0, Math.min(100, percent))
  for (let i = 1; i < BENCHMARK_ANCHORS.length; i++) {
    const [x0, y0] = BENCHMARK_ANCHORS[i - 1]
    const [x1, y1] = BENCHMARK_ANCHORS[i]
    if (clamped <= x1) {
      const t = x1 === x0 ? 0 : (clamped - x0) / (x1 - x0)
      return round(y0 + t * (y1 - y0))
    }
  }
  return 10
}

/** Calibrate an LMArena Elo onto the same 0-10 scale. */
export function calibrateElo(elo: number): number {
  if (!Number.isFinite(elo)) return 0
  // Elo sits in a narrow band; map 1100-1560 across the useful range.
  const clamped = Math.max(1100, Math.min(1560, elo))
  const percent = ((clamped - 1100) / (1560 - 1100)) * 100
  // Elo is a relative ranking, so use a flatter curve: differences at the top
  // are small in Elo but large in quality.
  return round(percent * 0.1)
}

/**
 * Convert raw benchmark columns into the four strength axes, each 0-10.
 *
 * The mapping is fixed and documented so a score can be audited:
 *   code     <- sweBench, terminalBench, liveCodeBench
 *   agentic  <- tauBench, terminalBench, osworld
 *   reasoning <- aime, gpqa, math
 *   general  <- mmluPro, lmarena, ifeval
 *
 * Each axis averages the calibrated contributions of its columns. A column
 * with no reported value is skipped rather than counted as zero, so a model
 * with three reported benchmarks is not penalised for the two it lacks.
 *
 * An axis with *no* reported column at all falls back to the metadata-derived
 * value for that axis. Scoring it zero would be an error: a model is not
 * non-agentic because nobody published its tau-bench, and a zero would drag
 * the composite below models that genuinely lack the capability.
 */
export function scoresFromBenchmarks(
  b: Benchmarks,
  fallback?: { reasoning: number; code: number; agentic: number; general: number },
): { reasoning: number; code: number; agentic: number; general: number } {
  const axis = (columns: Array<number | undefined>, fallbackValue: number) => {
    const values = columns.filter((v): v is number => v !== undefined && Number.isFinite(v))
    if (values.length === 0) return fallbackValue
    return values.reduce((sum, v) => sum + v, 0) / values.length
  }

  const f = fallback ?? { reasoning: 0, code: 0, agentic: 0, general: 0 }

  const reasoning = axis([
    b.aime === undefined ? undefined : calibrateBenchmark(b.aime),
    b.gpqa === undefined ? undefined : calibrateBenchmark(b.gpqa),
    b.math === undefined ? undefined : calibrateBenchmark(b.math),
  ], f.reasoning)
  const code = axis([
    b.sweBench === undefined ? undefined : calibrateBenchmark(b.sweBench),
    b.terminalBench === undefined ? undefined : calibrateBenchmark(b.terminalBench),
    b.liveCodeBench === undefined ? undefined : calibrateBenchmark(b.liveCodeBench),
  ], f.code)
  const agentic = axis([
    b.tauBench === undefined ? undefined : calibrateBenchmark(b.tauBench),
    b.terminalBench === undefined ? undefined : calibrateBenchmark(b.terminalBench),
    b.osworld === undefined ? undefined : calibrateBenchmark(b.osworld),
  ], f.agentic)
  const general = axis([
    b.mmluPro === undefined ? undefined : calibrateBenchmark(b.mmluPro),
    b.lmarena === undefined ? undefined : calibrateElo(b.lmarena),
    b.ifeval === undefined ? undefined : calibrateBenchmark(b.ifeval),
  ], f.general)

  return {
    reasoning: round(reasoning),
    code: round(code),
    agentic: round(agentic),
    general: round(general),
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
/**
 * Normalisers for continuous metadata signals.
 *
 * Each maps a real, sourced value onto 0-1 across a documented band, so the
 * result is comparable across models and auditable: change a band and every
 * score moves by a predictable amount.
 */
const PRICE_BAND = [0.02, 200] as const // USD per M tokens, blended
const RECENCY_BAND = [Date.UTC(2024, 0, 1), Date.UTC(2027, 0, 1)] as const
const CONTEXT_BAND = [4_000, 2_000_000] as const
const PARAMS_BAND = [0.5, 700] as const // billions of parameters

function normalize(value: number, band: readonly [number, number]): number {
  const [low, high] = band
  if (!Number.isFinite(value)) return 0.5
  if (value <= low) return 0
  if (value >= high) return 1
  return (value - low) / (high - low)
}

/** Price is multiplicative, so normalise on a log scale. */
function normalizePrice(price: number): number {
  if (price <= 0) return 0
  const [low, high] = PRICE_BAND
  return (Math.log(price) - Math.log(low)) / (Math.log(high) - Math.log(low))
}

/** Recency as a fraction of the band. Missing dates sit at the band midpoint. */
function normalizeRecency(releaseDate: string): number {
  const time = Date.parse(releaseDate)
  if (!Number.isFinite(time)) return 0.5
  return normalize(time, RECENCY_BAND)
}

function normalizeContext(context: number): number {
  if (context <= 0) return 0.5
  return normalize(context, CONTEXT_BAND)
}

/**
 * Parameter count, in billions.
 *
 * This is the strongest single predictor of a local model's capability and it
 * is *declared* by the model itself, so it is real data. An MoE model's total
 * parameter count is used: `120B-A12B` reports 120.
 */
function parameterBillions(parameterSize?: string): number {
  if (!parameterSize) return Number.NaN
  const match = /([\d.]+)\s*b/i.exec(parameterSize)
  if (!match) return Number.NaN
  const value = Number.parseFloat(match[1])
  return Number.isFinite(value) ? value : Number.NaN
}

function normalizeParams(parameterSize?: string): number {
  const billions = parameterBillions(parameterSize)
  if (!Number.isFinite(billions)) return 0.5
  return normalize(billions, PARAMS_BAND)
}

/**
 * A local model's capability signal, 0-1.
 *
 * Uses the *active* parameter count, not the total: an MoE model runs only its
 * active experts per token, so a 30B-total/3B-active model behaves like a 3B
 * model, not a 30B one. The total governs memory, which is `fitsLocally`'s
 * job, and conflating the two is what makes a 3B-effective model look like a
 * frontier model.
 *
 * A row with unknown weights returns null so the caller can fall back rather
 * than assume the midpoint and rank an unknown model above a known small one.
 */
function normalizeActive(weights: Weights | undefined): number | null {
  const active = weights?.active
  if (active === null || active === undefined || !Number.isFinite(active)) return null
  return normalize(active, PARAMS_BAND)
}

/* ------------------------------------------------------- hardware feasibility */

/**
 * Bytes per parameter at each common quantization, in GB per billion of
 * parameters. Ollama's default is Q4_K_M, which is what a pulled model uses
 * unless it was pulled with an explicit `:q8_` suffix.
 */
const QUANT_BYTES_PER_PARAM = {
  q4: 0.6,
  q5: 0.75,
  q8: 1.05,
  f16: 2.0,
} as const

export type Quant = keyof typeof QUANT_BYTES_PER_PARAM

/** A card to size models against. */
export interface HardwareProfile {
  name: string
  /** Total VRAM in GB. */
  vramGB: number
  /** Quantization a `pull` will fetch by default. */
  quant: Quant
}

/** An RTX 4090. The common case for a local-first setup. */
export const HARDWARE_4090: HardwareProfile = { name: "rtx-4090", vramGB: 24, quant: "q4" }

/**
 * VRAM fallback used when a profile is not supplied: enough for the small end,
 * small enough to exclude anything genuinely large.
 */
const DEFAULT_RESERVE_GB = 2.5

/**
 * Estimated VRAM in GB to run a model: weights at the profile's quantization,
 * plus a reserve for the KV cache, activations and CUDA overhead.
 *
 * The reserve is a flat estimate rather than a per-token cache model. It is
 * deliberately conservative: an underestimate here is what makes "local" mode
 * propose a model that will not load, which is worse than being slightly
 * pessimistic about a model that would have fit.
 */
export function estimateVRAM(weights: Weights | undefined, profile: HardwareProfile = HARDWARE_4090): number | null {
  const total = weights?.total
  if (total === null || total === undefined || !Number.isFinite(total)) return null
  const bytesPerParam = QUANT_BYTES_PER_PARAM[profile.quant]
  return total * bytesPerParam + DEFAULT_RESERVE_GB
}

/** Does this model fit in the profile's VRAM? Null when the weights are unknown. */
export function fitsLocally(weights: Weights | undefined, profile: HardwareProfile = HARDWARE_4090): boolean | null {
  const vram = estimateVRAM(weights, profile)
  if (vram === null) return null
  // Leave a margin for the desktop compositor and anything else holding VRAM.
  return vram <= profile.vramGB * 0.88
}

// Tier tokens in a model id or name are a vendor's own ranking of its lineup.
// These are the tokens vendors actually use, strongest to weakest.
const TIER_UP: Array<[RegExp, number]> = [
  [/\b(max|ultra|xxl|largest)\b/i, 1.0],
  [/\b(pro|plus|advanced|instruct|latest)\b/i, 0.6],
]
const TIER_DOWN: Array<[RegExp, number]> = [
  [/\b(nano|tiny|micro)\b/i, -1.0],
  [/\b(mini|small|flash|lite|air|instant|base)\b/i, -0.6],
]

function tierSignal(id: string, name: string): number {
  const hay = `${id} ${name}`
  let signal = 0
  for (const [pattern, weight] of TIER_UP) if (pattern.test(hay)) signal = Math.max(signal, weight)
  for (const [pattern, weight] of TIER_DOWN) if (pattern.test(hay)) signal = Math.min(signal, weight)
  return signal
}

/** A family version number, when the id carries one (claude-4-5, gpt-5.5). */
function generationSignal(family: string, id: string): number {
  const hay = `${family} ${id}`
  const match = /(?:\b|[^\d])(\d+(?:\.\d+)?)(?=\D*$|\b)/.exec(hay)
  const version = match ? Number.parseFloat(match[1]) : Number.NaN
  if (!Number.isFinite(version)) return 0.5
  // Band the version across the plausible range of a model lineup.
  return normalize(version, [1, 8])
}

/**
 * Derive scores from metadata when no benchmarks exist. This is explicitly a
 * fallback: the caller records `estimated: true` and lists these fields, so a
 * ranking built on derived data is distinguishable from one made on a report.
 *
 * Every axis is a weighted sum of *continuous* sourced signals, deliberately
 * not bucketed - bucketing is what makes a dozen frontier models score
 * identically and turns a ranking into a lottery.
 *
 * The weight split follows which signal actually predicts which axis:
 *
 * - **price** is the vendor's own statement of tier, so it dominates remote
 *   rows. A local row is unpriced, so price is dropped to a neutral prior
 *   rather than dragging every axis to the floor.
 * - **parameter count** is the equivalent statement for a local model and
 *   dominates there: a 120B MoE is not in the same class as a 4B dense one,
 *   and no amount of context or tag-boosting makes it so.
 * - **context** is deliberately a *minor* term everywhere. It measures
 *   capacity, not ability: a small model with a long window is still a small
 *   model, and weighting context heavily is what produces a 24B model ranked
 *   above a frontier one.
 * - **capability flags** (reasoning, tool calling, thinking) are binary
 *   capabilities, not strengths, so they contribute a modest fixed amount.
 */
export function scoresFromMetadata(row: RawRow): { reasoning: number; code: number; agentic: number; general: number } {
  const local = row.local
  const price = normalizePrice(row.pricing.input + row.pricing.output)
  // Active params for capability. Null when unknown, in which case the tier
  // signal is dropped rather than assumed, so an unmeasured local model is not
  // credited with a mid-sized one's capability.
  const active = normalizeActive(row.weights)
  const recency = normalizeRecency(row.releaseDate)
  const context = normalizeContext(row.context)
  const tier = tierSignal(row.id, row.name)
  const generation = generationSignal(row.family, row.id)
  const tierTerm = (tier + 1) * 0.5 // -1..1 -> 0..1

  // Remote: price is the vendor's tier statement. Local: active parameters are.
  // An unknown-weights local model gets 0 tier signal rather than a guess.
  const tierStrength = (local ? (active ?? 0) : price) * 0.4

  const reasoningSignal =
    tierStrength +
    recency * 0.15 +
    context * 0.05 +
    generation * 0.12 +
    (row.capabilities.reasoning ? 0.18 : 0) +
    tierTerm * 0.1

  const codeSignal =
    tierStrength +
    recency * 0.14 +
    generation * 0.13 +
    context * 0.04 +
    (row.capabilities.reasoning ? 0.08 : 0) +
    tierTerm * 0.11

  // Agentic leans on tool calling, which is a real capability fact, and on
  // parameter count for local models where tool use tracks model size.
  const agenticSignal =
    tierStrength +
    (row.capabilities.toolCall ? 0.2 : 0) +
    (row.capabilities.structured ? 0.06 : 0) +
    context * 0.08 +
    recency * 0.12 +
    generation * 0.07 +
    tierTerm * 0.07

  const knowledgeRecency = normalizeRecency(row.knowledge)
  const modalityBreadth = [
    row.capabilities.image,
    row.capabilities.pdf,
    row.capabilities.video,
    row.capabilities.audio,
  ].filter(Boolean).length * 0.04
  const generalSignal =
    tierStrength +
    knowledgeRecency * 0.16 +
    recency * 0.13 +
    generation * 0.1 +
    context * 0.04 +
    modalityBreadth +
    tierTerm * 0.07

  const toScore = (signal: number) => {
    // Map 0-1 onto 1.5-10 so no derived model reads as utterly incapable;
    // derived data is a prior, not a verdict.
    const scaled = 1.5 + Math.max(0, Math.min(1, signal)) * 8.5
    return Math.max(1, Math.min(10, Math.round(scaled * 100) / 100))
  }

  return {
    reasoning: toScore(reasoningSignal),
    code: toScore(codeSignal),
    agentic: toScore(agenticSignal),
    general: toScore(generalSignal),
  }
}

/** Combine an axis set into one composite capability score. */
export function capabilityFrom(scores: { reasoning: number; code: number; agentic: number; general: number }, context: number): number {
  const raw =
    scores.agentic * 0.34 +
    scores.code * 0.3 +
    scores.reasoning * 0.24 +
    scores.general * 0.12
  const contextTerm = context > 0 ? (Math.min(context, 400000) / 400000) * 10 : 5
  return round(raw * 0.9 + contextTerm * 0.1)
}

/** The capability tags a row advertises, for display. */
function capabilityTagList(caps: Record<string, boolean>): string[] {
  return Object.entries(caps).filter(([, on]) => on).map(([name]) => name)
}

/** Build one catalogue row from a raw row. */
export function toRow(raw: RawRow, ollamaRank?: number): CatalogueRow {
  const benchmarks = benchmarksFor(raw.canonicalID)
  const metadataScores = scoresFromMetadata(raw)
  // A reported axis wins; an unreported one falls back to the derived value
  // for that same axis, so a missing benchmark is a gap rather than a zero.
  const scored = benchmarks ? scoresFromBenchmarks(benchmarks, metadataScores) : metadataScores
  const estimated = benchmarks === null

  const scores = { ...scored, capability: capabilityFrom(scored, raw.context) }

  return {
    key: raw.variant ? `${raw.providerID}/${raw.id}#${raw.variant}` : `${raw.providerID}/${raw.id}`,
    providerID: raw.providerID,
    id: raw.id,
    name: raw.name,
    description: raw.description,
    family: raw.family,
    releaseDate: raw.releaseDate,
    knowledge: raw.knowledge,
    openWeights: raw.openWeights,
    context: raw.context,
    maxOutput: raw.maxOutput,
    capabilities: raw.capabilities,
    pricing: raw.pricing,
    local: raw.local,
    ...(ollamaRank !== undefined ? { ollamaRank } : {}),
    weights: raw.weights ?? UNKNOWN_WEIGHTS,
    cloud: raw.cloud ?? !raw.local,
    reachable: true,
    capabilityTags: raw.capabilities.toolCall || raw.capabilities.reasoning ? capabilityTagList(raw.capabilities) : [],
    canonicalID: raw.canonicalID,
    benchmarks,
    scores,
    // A curated free allowance keyed by `provider/model`. Applied at build
    // time so the persisted file is self-contained; load time re-applies the
    // table over stale files (see `lib/catalogue.ts`).
    freeTier: FREE_TIERS[`${raw.providerID}/${raw.id}`] ?? null,
    provenance: {
      metadata: raw.source,
      benchmark: benchmarks?.source ?? null,
      estimated,
      estimatedFields: estimated ? ["reasoning", "code", "agentic", "general"] : [],
    },
  }
}

/**
 * Fetch every source and build the catalogue document.
 *
 * A source that fails is skipped with a note rather than failing the build:
 * the catalogue is still useful with partial coverage, and the failure is
 * visible in `sources`.
 */
export async function fetchCatalogue(options: FetchOptions = {}): Promise<CatalogueDocument> {
  const sourceStats: CatalogueDocument["sources"] = []
  let raw: RawRow[] = []
  const ranks = new Map<string, number>()

  try {
    const payload = await getJSON(MODELS_DEV_URL, options)
    const rows = rowsFromModelsDev(payload)
    raw.push(...rows)
    sourceStats.push({ id: "models.dev", url: MODELS_DEV_URL, models: rows.length })
  } catch (error) {
    sourceStats.push({ id: "models.dev", url: MODELS_DEV_URL, models: 0 })
    console.error(`[catalogue] models.dev failed: ${messageOf(error)}`)
  }

  try {
    const rows = await rowsFromOllamaSearch(options)
    raw.push(...rows)
    sourceStats.push({ id: "ollama-popular", url: OLLAMA_SEARCH_URL, models: rows.length })
  } catch (error) {
    sourceStats.push({ id: "ollama-search", url: OLLAMA_SEARCH_URL, models: 0 })
    console.error(`[catalogue] ollama search failed: ${messageOf(error)}`)
  }

  // Alibaba Model Studio's own inventory. The whole source is switchable
  // (`ALIBABA_ENABLED`): `DONT_STOP_ALIBABA=0` skips it entirely. Without a
  // key it is skipped with a note rather than failing the build — models.dev
  // still covers the provider, just with its older snapshot.
  if (ALIBABA_ENABLED) {
    try {
      const entries = await fetchAlibabaInventory(options)
      const rows = rowsFromAlibaba(entries)
      raw.push(...rows)
      if (resolveAlibabaKey(options.alibabaKey)) {
        sourceStats.push({ id: "alibaba", url: ALIBABA_MODELS_URL, models: rows.length })
      } else {
        sourceStats.push({ id: "alibaba", url: ALIBABA_MODELS_URL, models: 0, note: "no ALIBABA_API_KEY configured; skipped" })
      }
    } catch (error) {
      sourceStats.push({ id: "alibaba", url: ALIBABA_MODELS_URL, models: 0 })
      console.error(`[catalogue] alibaba inventory failed: ${messageOf(error)}`)
    }
  } else {
    sourceStats.push({ id: "alibaba", url: ALIBABA_MODELS_URL, models: 0, note: "disabled" })
  }

  // models.dev carries alibaba/qwen rows too, so an off switch has to drop the
  // provider rather than only its own inventory — otherwise the cheapest rows
  // the free sweep picks first are still Alibaba's.
  if (!ALIBABA_ENABLED) {
    const before = raw.length
    raw = raw.filter((row) => row.providerID !== "alibaba")
    const stat = sourceStats.find((s) => s.id === "alibaba")
    if (stat) stat.models = before - raw.length
  }

  const installed = await localOllama(options)
  if (installed.size > 0) {
    sourceStats.push({ id: "ollama-local", url: OLLAMA_TAGS_URL, models: installed.size })
    for (const [name, info] of installed) {
      // `qwen3.8:latest` and `qwen3.8` are the same model with a tag appended,
      // so a popularity row matched on the base name supplies weights, context
      // and capability tags that the daemon does not report.
      const base = name.split(":")[0]
      const scraped = raw.find((r) => r.id === name && r.source === "ollama")
        ?? raw.find((r) => r.id === base && r.source === "ollama")

      // A tag on the installed name is a first-class statement of size:
      // `ollama pull qwen3-vl:30b` names its parameter count. It outranks a
      // scraped description when both exist.
      const tagWeights = parseWeights("", [name.split(":")[1] ?? ""])

      raw.push({
        providerID: "ollama",
        id: name,
        name,
        description: scraped?.description ?? "",
        family: scraped?.family ?? "",
        releaseDate: scraped?.releaseDate ?? "",
        knowledge: scraped?.knowledge ?? "",
        openWeights: true,
        context: info.context || scraped?.context || 0,
        maxOutput: scraped?.maxOutput ?? 0,
        capabilities: scraped?.capabilities ?? defaultCapabilities(),
        pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        canonicalID: scraped?.canonicalID ?? null,
        local: true,
        // The daemon lists only models it has actually pulled, so anything
        // here runs on this machine whatever ollama.com says about a cloud
        // option. A cloud tag on the popularity row must not demote an
        // installed model.
        cloud: false,
        weights: tagWeights.total !== null ? tagWeights : scraped?.weights ?? UNKNOWN_WEIGHTS,
        source: "local",
      })
    }
  }

  // Reachability: a row is usable only if the running server can route to it.
  // The set is empty-safe — an unreachable server leaves everything reachable
  // rather than empting the catalogue, and the plugin re-checks at load.
  //
  // The registry read is a *subprocess* (`opencode api get /api/model`) and
  // `execFileSync` blocks the event loop of whoever calls it. Run from the
  // plugin inside the server, that blocks the very server the CLI has to
  // talk to: the CLI gives up, restarts the service, and the refresh dies
  // before the file is written. In-server callers therefore pass
  // `registry: false` and rely on the engine's in-process re-derivation
  // (`applyReachability`); only the standalone update script needs this.
  const reachable = options.registry === false ? null : reachableModels()
  if (options.registry === false) {
    sourceStats.push({ id: "opencode-registry", url: "skipped (in-server)", models: 0 })
  } else if (reachable) {
    let unroutable = 0
    for (const row of raw) {
      if (!reachable.has(`${row.providerID}/${row.id}`)) {
        row.unroutable = true
        unroutable++
      }
    }
    sourceStats.push({ id: "opencode-registry", url: "server", models: reachable.size })
    if (unroutable > 0) {
      sourceStats.push({ id: "unroutable", url: "-", models: unroutable })
    }
  } else {
    sourceStats.push({ id: "opencode-registry", url: "server (unreachable)", models: 0 })
  }

  // Dedupe by key, keeping the most authoritative row for each model. A row
  // from the local daemon beats the popularity scrape; Alibaba's own
  // inventory beats models.dev's snapshot of the same provider; models.dev
  // beats the scrape. Ties keep the first row.
  const kept = new Map<string, { row: RawRow; rank: number | undefined }>()
  for (const row of raw) {
    const candidateKey = row.variant
      ? `${row.providerID}/${row.id}#${row.variant}`
      : `${row.providerID}/${row.id}`
    const priority = SOURCE_PRIORITY[row.source] ?? 0
    const existing = kept.get(candidateKey)
    if (existing && priority <= SOURCE_PRIORITY[existing.row.source]) continue
    kept.set(candidateKey, { row, rank: row.rank ?? ranks.get(row.id) })
  }

  const models: CatalogueRow[] = []
  for (const { row, rank } of kept.values()) {
    const candidate = toRow(row, rank)
    if (row.unroutable) candidate.reachable = false
    models.push(candidate)
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sources: sourceStats,
    models,
  }
}

/** Write the catalogue to disk as formatted JSON. */
export function writeCatalogue(document: CatalogueDocument, path = CATALOGUE_FILE): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8")
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
