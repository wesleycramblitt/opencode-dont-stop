# Filter cheap-mode (and all modes) to configured models

## Objective
Stop dont-stop from selecting provider models the user never configured
(e.g. `alibaba/qwen-turbo` when only `alibaba/qwen3.7-flash` is configured).
Reachability must mean "configured in opencode", not "listed by the registry".

## Acceptance criteria
- With `providers.alibaba.models = { "qwen3.7-flash" }` in opencode.json,
  `alibaba/qwen-turbo` is marked `reachable: false` after discovery and is
  never returned by `rankForMode` for any mode.
- Providers with no explicit `models` block behave exactly as today
  (registry decides).
- Unreadable/missing config changes nothing (fail open, no new unreachable).
- `npx tsc --noEmit` passes; `npx tsx scripts/test.ts` passes including new tests.

## Scope
- `lib/fetch.ts`: new config reader next to `keyFromConfig`.
- `lib/engine.ts`: `applyReachability` intersects the registry set with it.
- `scripts/test.ts`: cover the reader and the intersection.
- Refresh the stale `applyReachability` doc comment.

## Exclusions
- `data/catalogue.json` (generated artifact, do not hand-edit).
- TUI, state shape, mode ranking logic, project-local config merging.
- No alibaba-specific branches: the rule applies uniformly to every provider.

## Verification
- build: `npx tsc --noEmit`
- test: `npx tsx scripts/test.ts`
