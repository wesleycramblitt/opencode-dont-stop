# Context: filter to configured models

## Root cause (verified 2026-10-15, local evidence)
- `opencode api get /api/model` returns 113 models; 59 are `alibaba/*`,
  **all** with `enabled: true, status: "active"` — including `qwen-turbo`.
  This endpoint is the same source `LoopEngine.applyReachability` reads via
  `ctx.model.list()`, so per-model `enabled`/`status` cannot distinguish
  "configured" from "offered".
- `~/.config/opencode/opencode.json` `providers.alibaba.models` contains only
  `{"qwen3.7-flash": {...}}` (same shape for `ollama`: 7 explicit models).
- `data/catalogue.json` carries 106 `alibaba/*` rows, all persisted
  `reachable: true`; the engine overwrites this flag at load, so a runtime fix
  suffices — no catalogue rebuild needed.
- Result: `meets()` (`lib/catalogue.ts:380`, rejects `reachable === false`)
  admits every alibaba row, and cheap mode's cheapest-first sort picks
  `alibaba/qwen-turbo`, which the install cannot use.

## Working set
- `lib/engine.ts` `applyReachability` (~line 707): builds
  `usable: Set<"provider/id">` from `ctx.model.list()` (tolerates legacy
  `ctx.catalog.model.list()`), sets `model.reachable`, logs on count change,
  fail-open on error. Entry point `discover()` (~670); re-checks via
  `recheckReachability()` on the boot backoff (`index.ts`).
- `lib/fetch.ts` `keyFromConfig` (~line 775): reads the global config
  candidates `~/.config/opencode/opencode.json` + `.jsonc`, tolerates
  `{env:...}` placeholders and unreadable files. Reuse its candidates/pattern.
- `lib/catalogue.ts` `meets` (~380), `filter` (~410): already exclude
  `reachable === false`; no change needed there.
- `scripts/test.ts`: `node:test` + `assert/strict`, fake plugin contexts,
  run with `npx tsx scripts/test.ts`. Existing reachability test ~line 764.

## Implementation constraints
- Add `configuredModels(home?)` (name at Build's discretion) in `lib/fetch.ts`:
  returns `Map<providerID, Set<modelID>> | null`; `null`/absent entry = unknown.
  Parse `providers.<id>.models` keys from the same two global files. Ignore
  non-object `models` blocks. Never throw.
- In `applyReachability`, after building `usable`, delete any
  `"provider/id"` whose provider has a **non-empty** configured set not
  containing `id`. Empty/missing set = registry decides (unchanged).
- Match on `provider/id` only: catalogue alibaba rows carry no `variant`;
  registry `variants` (e.g. `none|high|max` on qwen models) are irrelevant.
- `reachableModels()` in `lib/fetch.ts` (~453, CLI-subprocess build path) is
  out of scope: in-server callers pass `registry: false` and the engine
  overwrites the persisted flag anyway.
- Narrow reading, encoded here: only the two **global** config files are read
  (same as key resolution); project-local `opencode.json` merging is excluded
  and must be noted in the final report, not implemented.
- Keep the packet's file ownership: `lib/fetch.ts`, `lib/engine.ts`,
  `scripts/test.ts` only.

## Test guidance
- Reader: tmp-HOME fixture with `opencode.json` (explicit models block),
  `.jsonc` fallback, missing-file fail-open, provider without `models` block.
- Engine: fake `ctx.model.list()` returning a configured and an unconfigured
  id for one provider plus a block-less provider; assert `reachable` flags and
  that `rankForMode(catalogue, "cheap", ...)` excludes the unconfigured row.
