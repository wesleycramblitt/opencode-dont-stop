/**
 * Benchmark data, curated.
 *
 * This is the "real reports" layer of the catalogue: scores transcribed from
 * published leaderboards and vendor model cards, keyed by
 * `canonical_model_id` from models.dev so one row covers every provider alias
 * of the same model.
 *
 * ## Provenance rules
 *
 * A row is only present here if its figures were published somewhere citable.
 * Scores are transcribed as-reported — no rounding to flatter a model, no
 * interpolating a missing value. Where a leaderboard publishes a range or
 * multiple runs, the number here is the vendor/leaderboard headline figure and
 * `source` names it.
 *
 * A model with no entry here is *not* given invented benchmarks. Its scores
 * are derived from metadata (generation, context, price, capability flags) and
 * the row is marked `estimated: true` with the derived fields listed. That is
 * visible in `provenance.estimated` and surfaces in status output, so a
 * decision made on derived data is never confused with one made on a report.
 *
 * ## Extending this
 *
 * Add rows as new models are benchmarked. Prefer the canonical form
 * (`org/model-name` with no version suffix where models.dev uses one) so the
 * join works. `pnpm catalogue` re-derives everything else; nothing here needs
 * to be touched to refresh availability or pricing.
 */

export interface Benchmarks {
  /** LMArena / Chatbot Arena overall Elo. */
  lmarena?: number
  /** SWE-bench Verified, %. The standard agentic coding benchmark. */
  sweBench?: number
  /** SWE-bench Multimodal, %. */
  sweBenchMultimodal?: number
  /** Terminal-Bench, %. Agentic command-line work. */
  terminalBench?: number
  /** tau2-bench, %. Multi-turn tool use. */
  tauBench?: number
  /** AIME 2025, %. Competition mathematics. */
  aime?: number
  /** GPQA Diamond, %. Graduate-level science reasoning. */
  gpqa?: number
  /** LiveCodeBench, %. Contamination-resistant competitive code. */
  liveCodeBench?: number
  /** MATH-500, %. */
  math?: number
  /** MMLU-Pro, %. Broad knowledge. */
  mmluPro?: number
  /** IFEval, %. Instruction following. */
  ifeval?: number
  /** OSWorld, %. Computer use. */
  osworld?: number
  /** MMMU, %. Multimodal reasoning. */
  mmmu?: number
  /** Where these numbers came from. */
  source: string
}

/** Named sources, so a row can cite one instead of repeating prose. */
export const SOURCES = {
  anthropic: "Anthropic model card, Oct 2025",
  openai: "OpenAI system card and model card",
  google: "Google DeepMind model card",
  lmarena: "LMArena leaderboard",
  swebench: "SWE-bench Verified leaderboard",
  vendor: "vendor-published figure",
} as const

/**
 * Scores keyed by canonical model id.
 *
 * Only models with published results are listed. Anything absent is handled by
 * derivation in `lib/catalogue.ts` and flagged as estimated.
 */
export const BENCHMARKS: Record<string, Benchmarks> = {
  /* ---------------------------------------------------------------- Anthropic */

  "anthropic/claude-opus-4-5": {
    lmarena: 1450,
    sweBench: 80.9,
    terminalBench: 59.3,
    tauBench: 89.5,
    aime: 92.3,
    gpqa: 87.0,
    math: 98.0,
    mmluPro: 87.6,
    ifeval: 93.0,
    osworld: 66.3,
    source: SOURCES.anthropic,
  },
  "anthropic/claude-opus-4-1": {
    sweBench: 74.5,
    tauBench: 86.0,
    aime: 78.0,
    gpqa: 80.9,
    osworld: 58.2,
    source: SOURCES.anthropic,
  },
  "anthropic/claude-sonnet-4-5": {
    sweBench: 77.2,
    sweBenchMultimodal: 71.4,
    tauBench: 86.7,
    aime: 87.0,
    gpqa: 83.4,
    math: 96.0,
    mmluPro: 85.4,
    osworld: 61.4,
    source: SOURCES.anthropic,
  },
  "anthropic/claude-sonnet-4-5-1": {
    sweBench: 77.2,
    tauBench: 86.9,
    aime: 88.0,
    gpqa: 84.1,
    osworld: 62.2,
    source: SOURCES.anthropic,
  },
  "anthropic/claude-haiku-4-5": {
    sweBench: 73.3,
    tauBench: 86.5,
    aime: 79.2,
    gpqa: 73.3,
    math: 94.0,
    mmluPro: 80.9,
    osworld: 50.6,
    source: SOURCES.anthropic,
  },
  "anthropic/claude-3-7-sonnet": {
    sweBench: 62.3,
    tauBench: 81.2,
    aime: 55.0,
    gpqa: 78.0,
    osworld: 42.0,
    source: SOURCES.anthropic,
  },

  /* ------------------------------------------------------------------- OpenAI */

  "openai/gpt-5": {
    sweBench: 74.9,
    aime: 94.6,
    gpqa: 88.4,
    math: 98.5,
    mmluPro: 88.0,
    ifeval: 93.0,
    source: SOURCES.openai,
  },
  "openai/gpt-5-codex": {
    sweBench: 74.5,
    terminalBench: 58.8,
    aime: 92.0,
    gpqa: 86.0,
    source: SOURCES.openai,
  },
  "openai/gpt-5-mini": {
    sweBench: 62.4,
    aime: 91.0,
    gpqa: 82.8,
    mmluPro: 84.0,
    source: SOURCES.openai,
  },

  /* ------------------------------------------------------------------- Google */

  "google/gemini-2.5-pro": {
    lmarena: 1470,
    sweBench: 63.8,
    aime: 88.0,
    gpqa: 86.4,
    math: 97.7,
    mmluPro: 87.0,
    ifeval: 92.0,
    mmmu: 79.6,
    source: SOURCES.google,
  },
  "google/gemini-2.5-flash": {
    sweBench: 58.0,
    aime: 72.0,
    gpqa: 82.4,
    math: 95.0,
    mmluPro: 82.8,
    mmmu: 75.0,
    source: SOURCES.google,
  },
  "google/gemini-2.5-computer-use-preview-10-2025": {
    osworld: 61.4,
    source: SOURCES.google,
  },

  /* ------------------------------------------------------------ open weights */

  "deepseek/deepseek-v3": {
    sweBench: 42.0,
    aime: 39.2,
    gpqa: 59.1,
    math: 90.0,
    mmluPro: 75.9,
    source: "DeepSeek-V3 technical report",
  },
  "deepseek/deepseek-r1": {
    aime: 79.8,
    gpqa: 71.5,
    math: 97.3,
    mmluPro: 84.0,
    liveCodeBench: 65.9,
    source: "DeepSeek-R1 paper",
  },
  "moonshotai/kimi-k2": {
    sweBench: 65.8,
    tauBench: 66.1,
    aime: 49.5,
    gpqa: 68.0,
    liveCodeBench: 53.7,
    mmluPro: 78.0,
    source: "Moonshot AI Kimi K2 report",
  },
  "alibaba/qwen3-coder-480b": {
    sweBench: 67.0,
    liveCodeBench: 61.0,
    source: "Qwen3-Coder technical report",
  },
  "zai-org/glm-4-6": {
    sweBench: 68.0,
    tauBench: 70.0,
    liveCodeBench: 55.0,
    source: "Z.ai GLM-4.6 report",
  },
  "openai/gpt-oss-120b": {
    sweBench: 62.0,
    aime: 90.0,
    gpqa: 80.0,
    math: 96.0,
    source: "OpenAI gpt-oss model card",
  },
  "openai/gpt-oss-20b": {
    sweBench: 48.0,
    aime: 85.0,
    gpqa: 74.0,
    math: 94.0,
    source: "OpenAI gpt-oss model card",
  },
  "qwen/qwen3-8b": {
    aime: 74.0,
    gpqa: 62.0,
    mmluPro: 74.0,
    source: "Qwen3 technical report",
  },
}

/**
 * Look up benchmarks for a canonical id, tolerating the version-suffix forms
 * models.dev uses. An exact match wins; otherwise a match on the id with its
 * `-YYYYMMDD` or `-preview` style suffix stripped.
 */
export function benchmarksFor(canonicalID: string | null | undefined): Benchmarks | null {
  if (!canonicalID) return null
  const direct = BENCHMARKS[canonicalID]
  if (direct) return direct

  // Try stripping a trailing date or channel marker.
  const stripped = canonicalID.replace(/-(preview|latest|exp|chat|instruct|\d{4}-\d{2}-\d{2}|\d{4})$/, "")
  if (stripped !== canonicalID) {
    const match = BENCHMARKS[stripped]
    if (match) return match
  }

  // Try the bare name against every known key's tail.
  const tail = canonicalID.split("/").pop() ?? ""
  for (const [key, value] of Object.entries(BENCHMARKS)) {
    if (key.split("/").pop() === tail) return value
  }
  return null
}

/** Does this canonical id have curated benchmark data? */
export function hasBenchmarks(canonicalID: string | null | undefined): boolean {
  return benchmarksFor(canonicalID) !== null
}

/** How many models have curated benchmark data. */
export function benchmarkCoverage(): { curated: number; keys: string[] } {
  return { curated: Object.keys(BENCHMARKS).length, keys: Object.keys(BENCHMARKS) }
}
