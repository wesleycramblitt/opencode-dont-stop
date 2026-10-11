/**
 * dont-stop — declared free tiers.
 *
 * Alibaba Model Studio grants a per-model promotional free quota to accounts
 * (commonly 1M tokens within 90 days). The allowance is per model, displayed
 * in the Model Studio console, and not queryable through any public API — so
 * it is curated here instead, as declared data with a source on every row.
 *
 * How to maintain this table:
 *
 *   1. Check the Model Studio console for the models that carry a free quota
 *      on your account (the quota is account-scoped, so verify, don't guess).
 *   2. Add or remove a line here per model. The key is `provider/model` as
 *      the catalogue writes it (the id the provider itself uses).
 *   3. Run `npx tsx scripts/update-catalogue.ts` to fold the table into
 *      `data/catalogue.json`, which is what the ranking reads.
 *
 * The catalogue applies this table at both build time (into the persisted
 * rows) and load time (over a stale file), so a change here takes effect
 * without a rebuild.
 *
 * A quota-backed model is not priced at zero — it is a paid model with a
 * promotional allowance — so it sits in the `free` sweep *after* the genuinely
 * free rows and *before* the local fallback, and in `cheap` mode it is simply
 * a paid candidate ranked by price.
 */

export interface FreeTier {
  /** Tokens granted inside the window. */
  tokens: number
  /** Window length in days. */
  windowDays: number
  /** Where this fact came from. */
  source: string
}

/**
 * Keyed by `provider/model`. Sources are named so a number can be audited;
 * `sources` below the table explain each label.
 */
export const FREE_TIERS: Record<string, FreeTier> = {
  // Alibaba Model Studio's published free tier (per-model quota for accounts).
  // Verified against the Model Studio model pages / free-tier promotion as of
  // 2026-08 and the user's own account statement that the flash line carries
  // the 1M-tokens-per-90-days allowance.
  "alibaba/qwen3.7-flash": { tokens: 1_000_000, windowDays: 90, source: "alibaba-promotion-1m-90d" },
  "alibaba/qwen3.6-flash": { tokens: 1_000_000, windowDays: 90, source: "alibaba-promotion-1m-90d" },
  "alibaba/qwen3.5-flash": { tokens: 1_000_000, windowDays: 90, source: "alibaba-promotion-1m-90d" },
  "alibaba/qwen-flash": { tokens: 1_000_000, windowDays: 90, source: "alibaba-promotion-1m-90d" },
  "alibaba/qwen3-coder-flash": { tokens: 1_000_000, windowDays: 90, source: "alibaba-promotion-1m-90d" },
  "alibaba/qwen-turbo": { tokens: 1_000_000, windowDays: 90, source: "alibaba-promotion-1m-90d" },
  "alibaba/qwen-plus": { tokens: 1_000_000, windowDays: 90, source: "alibaba-promotion-1m-90d" },
  "alibaba/qwen3-coder-plus": { tokens: 1_000_000, windowDays: 90, source: "alibaba-promotion-1m-90d" },
  "alibaba/deepseek-v4-flash-0731": { tokens: 1_000_000, windowDays: 90, source: "alibaba-promotion-1m-90d" },
}

/** Rows with a declared free tier, in a stable order. */
export function freeTierKeys(): string[] {
  return Object.keys(FREE_TIERS).sort()
}