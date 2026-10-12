/**
 * dont-stop — declared free tiers.
 *
 * Alibaba Model Studio grants accounts a per-model promotional free quota.
 * The allowance is per model, displayed in the console, and not queryable
 * through any public API — so it is curated here instead, as declared data.
 *
 * **The table is empty (2026-10-12): the grants have been consumed.** The
 * overnight loop drew them down model after model, and the provider refused
 * each model it reached with "The free quota has been exhausted" — the
 * `freequota` classification in `lib/errors.ts`. The grants are one-time
 * (1M tokens inside 91 days, expiring 2027-01-10, no reset), so those models
 * are paid rows now and the free sweep must not offer them again.
 *
 * For the record, the 2026-10-12 snapshot listed 34 models on the standard
 * promotion — every row switched on in the console — plus `qwen-plus` on an
 * older 131-day grant expiring 2026-11-11. Git history holds the full list.
 *
 * Two things were never in the table, by the contract below:
 *
 * - **wan2.2-kf2v-flash**: its free quota counts *generations* (50), not
 *   tokens, and the catalogue never admits it — it is a video model, not a
 *   chat model — so recording a token-shaped tier for it would be wrong.
 * - **Models whose promotional quota is spent.** That is now every Alibaba
 *   model, which is why the lists below are empty.
 *
 * How to maintain this table:
 *
 *   1. Copy the free-tier page of the Model Studio console (model, remaining,
 *      total, expiry, enabled).
 *   2. Add a line to the lists below for every model whose allowance is
 *      alive. The key is `provider/model` as the catalogue writes it (the id
 *      the provider itself uses).
 *   3. Update SNAPSHOT so every `source` string dates itself.
 *   4. Run `npx tsx scripts/update-catalogue.ts` to fold the table into
 *      `data/catalogue.json`, which is what the ranking reads.
 *
 * The catalogue applies this table at load time, and the table *is* the
 * answer: absence means spent, so a removal here takes effect without a
 * rebuild. A persisted row's copy is a snapshot of an older table and must
 * not outvote a spent quota.
 *
 * A quota-backed model is not priced at zero — it is a paid model with a
 * promotional allowance — so it sits in the `free` sweep *after* the genuinely
 * free rows and *before* the local fallback. The allowance is never *measured*
 * by the plugin: there is no usage API, and when the quota runs out the
 * provider's free-quota error is classified as `freequota` and the model is
 * excluded from the free sweep for good (see lib/errors.ts).
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
const SNAPSHOT = "2026-10-12"

/** The standard promotion: 1M tokens per model inside 91 days. */
const PROMOTION_1M_90D = `alibaba model studio console ${SNAPSHOT}: 1M tokens / 91-day promotion`

/**
 * Models with a live 91-day grant. Empty: every allowance in the 2026-10-12
 * snapshot was consumed by the overnight loop before this line was cleared.
 */
const ENABLED_PROMOTION: readonly string[] = []

/**
 * Quotas granted but not switched on in the console. None today; kept as a
 * list so a future console state can add rows back without reshaping the
 * table.
 */
const UNENABLED_PROMOTION: readonly string[] = []

/** Keyed by `provider/model`. Empty means no allowance is alive. */
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
}

/** Rows with a declared free tier, in a stable order. */
export function freeTierKeys(): string[] {
  return Object.keys(FREE_TIERS).sort()
}
