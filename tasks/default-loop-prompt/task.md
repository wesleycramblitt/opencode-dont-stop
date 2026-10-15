# Default loop prompt for bare `start`

## Objective
A bare `dont-stop-set start` (no text, no stored loop prompt) arms the loop
with a plugin-shipped default prompt instead of returning a usage error.
There is always something to do; there is never a reason to print usage.

## Acceptance criteria
- `start` with no text and no stored prompt starts the loop with the default
  prompt, and the reply/log says the default prompt was used.
- `start <text>` behavior unchanged (text wins).
- Bare `start` with a stored prompt unchanged (stored prompt wins: text >
  stored > default).
- `start` with no target session still errors (`no session to run the loop on`).
- The default prompt follows the backlog-role recipe: infinite work stream,
  per-turn forced move (`STATUS`/`NEXT`), terminal declarations forbidden,
  progress on disk. It must be genuinely generic (no knowledge of any task).
- `npx tsc --noEmit` passes; `npx tsx scripts/test.ts` passes including new tests.

## Scope
- New `prompts/default-loop.md`: the generic steward prompt.
- New loader (suggested `lib/default-prompt.ts`): read the file relative to
  the module (same `fileURLToPath` pattern as `catalogue.ts` `FALLBACK_PATH`),
  cache it, fall back to an inline constant when missing/unreadable.
- `runCommand` in `index.ts`: use the loader in the start path.
- `scripts/test.ts`: cover loader (file, missing-file fallback) and start
  precedence (text > stored > default) with a fake engine capturing the prompt.

## Exclusions
- `prompts/loop.md` (the authoring template) stays as-is.
- TUI changes: the TUI has no start path today.
- `data/catalogue.json` (generated artifact).

## Verification
- build: `npx tsc --noEmit`
- test: `npx tsx scripts/test.ts`
