# Session-scoped TUI (footer, halting, toasts)

## Objective
Footers and toasts reflect only the current session's loop. A session
with no loop shows `idle`; `halting…` appears only on sessions whose
loop is actually halting; after a halt completes the footer says `idle`.

## Acceptance criteria
- Footer in a session with no `state.loops[sessionID]` shows `idle`,
  never another session's iteration count or `halting…`.
- `halting…` shows only while this session's loop is active with a
  pending halt aimed at it; cleared the moment the halt lands.
- Toasts fire only for transitions of the current session's loop.
- After a halt completes, affected sessions show `idle`.
- `npx tsc --noEmit` passes.

## Scope
- `tui.tsx`: `loopForFooter` (drop newest-anywhere fallback), the
  `halting` predicate in `DontStopFooter`, the `announceInterval`
  toast selection (`here ?? primary` fallback).
- Keep `followSession` rotation-follow behavior as-is.

## Exclusions
- Engine stop paths and intent shape (owned by auto-halt-cause task:
  do not change `Intent`, `applyIntent`, or `stop` here).
- No server-half changes (`index.ts`, `lib/`).

## Verification
- build: `npx tsc --noEmit`
- test: existing `npx tsx scripts/test.ts` (no new suite required)
