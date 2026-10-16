# dont-stop

A self-sustaining session loop plugin for OpenCode. It reinjects prompts, manages sessions, and recovers from hangs and restarts. Model selection belongs to the sibling [model-selector](../model-selector/) plugin.

## What it does

`dont-stop-set start <prompt>` arms a loop on a session. The loop drives itself by advancing on each turn boundary (`session.execution.*` events), re-injecting the mission prompt at cadence intervals, compacting transcripts when step budgets are exceeded, and detecting rotated sessions (message count drops) to re-seed with the full prompt.

The loop ends **only** when its owner halts it — never due to iteration budget, consecutive errors, or exhaustion.

### Ownership

Loops belong to the instance that started them (`owner`). Advancing, interrupting, rotating only happen there; other instances report but don't drive. A loop orphaned by a service restart is recovered on boot (adopted when its session still exists, halted otherwise). Boot recovery differs from mid-run recovery because opencode's own session resume may already be handling things.

### Hangs

When a running session goes completely silent for `hangMs` (3min default), the engine interrupts the entire session tree (root + live descendants transitively), records the interrupt timestamp, then schedules a re-drive. The re-drive fires at a configurable delay after the hang (20s default for settle time). The hang marker prevents the turn-end event from double-driving the loop.

`dont-stop` does not own model selection — it never calls or writes to `model-selector`. The two plugins are independent; `model-selector` observes `session.error` / `session.execution.failed` events itself and rotates models in-process.

### Session rotation

Session rotation happens when:
1. **Step budget exceeded** — configurable turns in one session (default 30). A new session is created empty, seeded with a context-fresh message, the retired session deleted, and the loop record moved to the successor.
2. **Context pressure** — usage at a threshold fraction of the effective window (default 80%). This keeps OpenCode's auto-compaction theoretical rather than the primary mechanism.

Rotation refuses while subagents are live (descendants transitively) and retries on the next turn when they finish. The success or failure of `remove()` on the retired session is non-fatal.

### Errors

Stale reasoning-state detection (`/reasoning.{0,40}(not found|expired)/i`) is handled locally: transcript compaction + re-drive. Full error classification and model-level recovery is owned by `model-selector/lib/errors.ts`.

## Commands

```
/dont-stop-set status          # Show loops, intent, recent logs
/dont-stop-set start <prompt>  # Start loop on latest tracked session
/dont-stop-set start --prompt-file PATH  # Start from file
/dont-stop-set stop [session]  # Halt all loops or one by session ID
/dont-stop-set track <session> # Track an additional session
```

## Loop flow

```
start → send opening prompt → wait for session execution events
session.execution.succeeded → advance()
  - increment iterations/sessionIterations
  - if step budget hit → compact
  - if rotation needed → create successor, move loop record
  - else → nudge ("Continue.") or full mission restatement
    (after compaction, on cadence, or when turn used no tool)
```

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Server entrypoint: command API, event pump, state watch |
| `tui.tsx` | Terminal entrypoint: footer status, halt writer, toasts |
| `lib/engine.ts` | Loop engine: clocks, observe, advance, rotate, recover |
| `lib/state.ts` | Durable state bridging server and TUI halves |
| `lib/clocks.ts` | Heartbeat / idle / hang clocks |
| `lib/events.ts` | OpenCode v2 event vocabulary |
| `lib/rotation.ts` | Session rotation helpers: context measurement, tree walking |
| `lib/default-prompt.ts` | Shipped default loop prompt loader |
| `scripts/test.ts` | Unit tests |

Model-selection modules previously here (`catalogue`, `modes`, `errors`, `apply`, `fetch`, `data/`) moved to `plugins/model-selector/`.

## Disabling

`DONT_STOP_DISABLED=1` — env var honored at load by both halves with no restart: server loads inert, terminal renders `◍ dont-stop off`.

## Development

```
./node_modules/.bin/tsc --noEmit -p .      # typecheck (excludes tui.tsx)
npx tsx scripts/test.ts                    # unit tests
```

`tui.tsx` is excluded from local typecheck because it imports runtime-only packages (`@opencode/plugin/tui`, `@opentui/solid`).
