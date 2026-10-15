# Context: default loop prompt for bare `start`

## Current behavior (`runCommand`, `index.ts` ~400-448)
- `start --prompt-file PATH [inline]`: file prompt, optional inline prefix.
- `start <text>`: `engine.start(target, prompt)`.
- Bare `start`: reuses `engine.primaryLoop()?.prompt` when present; otherwise
  warns and returns `usage: dont-stop-set start <prompt> | ...`.
- Target session: `sessionID ?? newestTrackedFor(engine)`; none → error. Keep.
- `engine.start(sessionID, prompt, mode?)` (`lib/engine.ts` ~2191) stores the
  prompt on the loop record; later turns restate it via `missionOf` →
  `missionText` (prompt + "Keep working."). No prompt validation there.

## Prompt content requirements (`prompts/default-loop.md`)
Genuinely task-agnostic steward for any repo checkout:
- Survey first: `git status`, open TODO/backlog/notes files, recent commits;
  pick up the most important unfinished work and continue it.
- Nothing unfinished: run a verification pass (tests, lint/typecheck, docs
  drift) and fix or file what it finds; an empty queue means mint new work.
- Every turn ends with tool calls or a `STATUS:`/`NEXT:` line; the words
  "complete", "done", "finished", "nothing remains" (as terminal declarations)
  are forbidden. Progress goes to on-disk files the prompt names
  generically (e.g. `notes/`, TODO files found in the survey).
- Keep it short: this prompt is restated verbatim on stagnant turns and
  re-drives, so brevity compounds.

## Loader constraints
- Resolve relative to the module, not `process.cwd()` (the server's cwd is
  wherever the service launched; `index.ts` `resolvePromptFile` documents this
  trap). Follow `catalogue.ts` (`HERE`/`FALLBACK_PATH`) or `fetch.ts`
  (`CATALOGUE_FILE`) precedent.
- Never throw: missing/empty file → inline fallback constant (a compact
  steward prompt, same rules, compressed). Log the fallback at warn level via
  the passed logger, if a logger is easily available; otherwise stay silent —
  do not invent new logging plumbing.
- Cache the file read; the start path runs rarely but heartbeats must not pay.

## Test guidance (`scripts/test.ts`, `node:test` + `assert/strict`)
- Loader: real file → content returned; unreadable/missing → non-empty
  fallback. (Pass an explicit base dir into the loader for tests rather than
  touching the shipped file.)
- Precedence: fake engine capturing `start(sessionID, prompt)` —
  text beats stored, stored beats default. Reuse the file's existing
  `makeEngine`/fake-context patterns; `runCommand` takes
  `{ state, engine, log, persist, sessionID, baseDir }`.
- Note: 5 pre-existing failures (tests 74-78, session rotation) fail on the
  clean tree; do not chase them. New-test count must not regress 91 passing.
