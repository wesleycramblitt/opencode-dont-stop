/**
 * dont-stop — declared free tiers.
 *
 * Alibaba Model Studio grants accounts a per-model promotional free quota.
 * The allowance is per model, displayed in the console, and not queryable
 * through any public API — so it is curated here instead, as declared data.
 *
 * The data below is a snapshot of one account's free-tier console (2026-10-11):
 *
 * - **1M tokens / 91 days** granted per model, expiry 2027-01-10, untouched
 *   (1M / 1M remaining). These are the bulk of the table.
 * - **qwen-plus** is an older grant with its own window (131 days, expiring
 *   sooner — 2026-11-11), so it is listed separately rather than lumped in.
 * - **Vision models** (wan*, happyhorse*, z-image, qwen-image*) are NOT here:
 *   their free quota counts *generations* (10-200), not tokens, and the
 *   catalogue never admits them — they are image/video models, not chat
 *   models — so recording a token-shaped tier for them would be wrong.
 * - **Enabled / Not Enabled** is account state, captured in `enabled`. The
 *   sweep orders enabled quotas first, but a switched-on model is only a
 *   console setting away, so unenabled rows stay in the chain rather than
 *   out of it.
 *
 * How to maintain this table:
 *
 *   1. Copy the free-tier page of the Model Studio console (model, remaining,
 *      total, expiry, enabled).
 *   2. Add or remove a line from the lists below. The key is `provider/model`
 *      as the catalogue writes it (the id the provider itself uses).
 *   3. Update SNAPSHOT so every `source` string dates itself.
 *   4. Run `npx tsx scripts/update-catalogue.ts` to fold the table into
 *      `data/catalogue.json`, which is what the ranking reads.
 *
 * The catalogue applies this table at both build time (into the persisted
 * rows) and load time (over a stale file), so a change here takes effect
 * without a rebuild.
 *
 * A quota-backed model is not priced at zero — it is a paid model with a
 * promotional allowance — so it sits in the `free` sweep *after* the genuinely
 * free rows and *before* the local fallback. The allowance is never *measured*
 * by the plugin: there is no usage API, and when the quota runs out the
 * provider's quota error is classified as `funds`, the model goes on cooldown,
 * and the chain moves on.
 */

export interface FreeTier {
  /** Tokens granted inside the window. */
  tokens: number
  /** Window length in days. */
  windowDays: number
  /** Whether the account currently has the model switched on for use. */
  enabled: boolean
  /** Where this fact came from. */
  source: string
}

/** Date of the console snapshot the arrays below were taken from. */
const SNAPSHOT = "2026-10-11"

/** The standard promotion: 1M tokens per model inside 91 days. */
const PROMOTION_1M_90D = `alibaba model studio console ${SNAPSHOT}: 1M tokens / 91-day promotion`

/** The older account-level grant with its own, shorter remaining window. */
const LEGACY_GRANT = `alibaba model studio console ${SNAPSHOT}: legacy grant, expires 2026-11-11`

/** The 91-day quotas the account currently has switched on. */
const ENABLED_PROMOTION: readonly string[] = [
  "glm-5.1",
  "glm-5.2",
  "kimi-k2.7-code",
  "qwen-max",
  "qwen-mt-flash",
  "qwen-vl-ocr-2025-11-20",
  "qwen3.5-122b-a10b",
  "qwen3.5-plus-2026-02-15",
  "qwen3.6-plus",
  "qwen3.7-flash",
  "qwen3.7-flash-2026-07-15",
  "qwen3.7-max",
  "qwen3.7-max-2026-05-17",
  "qwen3.7-max-2026-05-20",
  "qwen3.7-max-2026-06-08",
  "qwen3.7-max-preview",
  "qwen3.7-plus",
  "qwen3.7-plus-2026-05-26",
]

/**
 * Quota granted but not switched on in the console. Kept with `enabled:
 * false` so the sweep can prefer the active quotas while still listing these
 * — enablement is a settings flip, not a property of the model.
 */
const UNENABLED_PROMOTION: readonly string[] = [
  "deepseek-v4-flash-0731",
  "deepseek-v4-pro",
  "deepseek-v4-pro-0813",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "kimi-k3",
  "qwen-flash",
  "qwen-flash-2025-07-28",
  "qwen-flash-character",
  "qwen-mt-lite",
  "qwen-mt-plus",
  "qwen-plus-character",
  "qwen-plus-latest",
  "qwen-plus-2025-04-28",
  "qwen-plus-2025-07-14",
  "qwen-plus-2025-12-01",
  "qwen3-coder-flash",
  "qwen3-coder-flash-2025-07-28",
  "qwen3-vl-plus",
  "qwen3.5-27b",
  "qwen3.5-35b-a3b",
  "qwen3.5-397b-a17b",
  "qwen3.5-flash",
  "qwen3.5-flash-2026-02-23",
  "qwen3.5-plus",
  "qwen3.5-plus-2026-04-20",
  "qwen3.6-27b",
  "qwen3.6-35b-a3b",
  "qwen3.6-flash",
  "qwen3.6-flash-2026-04-16",
  "qwen3.6-plus-2026-04-02",
  "qwen3.8-2.4t-a95b",
  "qwen3.8-27b",
  "qwen3.8-flash",
  "qwen3.8-max-0902",
]

/** Keyed by `provider/model`. Sources are named so a number can be audited. */
export const FREE_TIERS: Record<string, FreeTier> = {
  ...Object.fromEntries(
    ENABLED_PROMOTION.map((id) => [
      `alibaba/${id}`,
      { tokens: 1_000_000, windowDays: 91, enabled: true, source: PROMOTION_1M_90D },
    ]),
  ),
  ...Object.fromEntries(
    UNENABLED_PROMOTION.map((id) => [
      `alibaba/${id}`,
      { tokens: 1_000_000, windowDays: 91, enabled: false, source: PROMOTION_1M_90D },
    ]),
  ),
  // The legacy grant runs on its own window and expires sooner.
  "alibaba/qwen-plus": { tokens: 1_000_000, windowDays: 131, enabled: false, source: LEGACY_GRANT },
}

/** Rows with a declared free tier, in a stable order. */
export function freeTierKeys(): string[] {
  return Object.keys(FREE_TIERS).sort()
}