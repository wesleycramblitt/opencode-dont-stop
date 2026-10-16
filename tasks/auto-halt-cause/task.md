# Auto-halt root cause (diagnose, then guard)

## Objective
Establish which stop path halted the loop on its own (orphan reap,
unload teardown, rotation successor, start-failure, or intent replay)
from the state file and logs, then make that path non-silent and
non-spurious. No iteration budget exists today — confirm that too.

## Acceptance criteria
- The firing path is named with evidence (state-file `log` tail +
  `lastResult` + stdout line), recorded in the task report.
- The firing path logs a distinct warn/error before stopping and leaves
  a distinct `lastResult` (no two silent halts share a message).
- A halt intent never re-fires on a later loop: intent is consumed or
  scoped so `halting…` cannot stick and old intents cannot kill new
  loops.
- Hot-reload/unload teardown cannot tear down a healthy loop
  (keep the 30s boot-window rule or stronger; loops survive reload).
- `npx tsc --noEmit` passes; `npx tsx scripts/test.ts` passes.

## Scope
- `lib/engine.ts`: `applyIntent`, `stop` (incl. the `bumpIntent("halt")`
  inside `stop`), `reapOrphanedLoops`, `recoverOrphanedLoops`, `doRotate`.
- `index.ts`: unload `teardown` (30s rule).
- `lib/state.ts`: only if intent must be consumed/scoped; nothing else.

## Exclusions
- TUI rendering (owned by session-scoped-tui; do not touch `tui.tsx`).
- Adding an iteration cap: `advance` logs-and-continues past
  `maxIterations` by design — document, don't cap.
- Model-selector behavior.

## Verification
- build: `npx tsc --noEmit`
- test: `npx tsx scripts/test.ts`
- live check (read-only): inspect `~/.config/opencode/dont-stop-state.json`
  (`log` tail, per-loop `lastResult`, `intent.seq`) to name the path.
