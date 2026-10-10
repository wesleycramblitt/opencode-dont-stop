# dont-stop

A self-sustaining loop plugin for OpenCode, with deterministic model selection
across four modes and a fix for the bug that made profile switches appear to do
nothing.

## The bug this fixes

An OpenCode session pins its own model in `Session.Info.model`, and that pin
overrides the agent's default. Rewriting an agent definition — which is what a
profile plugin does — therefore only affects sessions created *afterwards*.
On any already-running session, a mode change looked like a no-op.

`lib/apply.ts` pushes every plan through **both** channels:

| Channel | Reaches | API |
| --- | --- | --- |
| Agent definitions | new sessions and subagents | `ctx.agent.transform` |
| Pinned session models | sessions already running | `ctx.session.switchModel` |

The second is the one that fixes the reported symptom. Skipping it is the bug.

## Modes

| Mode | Selects | On failure |
| --- | --- | --- |
| `free` | verified zero-cost models, swept by capability, then the best local model as fallback | next free model; re-sweep when the task completes |
| `cheap` | cheapest model that can actually do the task | next cheapest; degrade to `free` on low funds |
| `local` | best local model for the task, GPU-aware | next local model; remote only if nothing local can serve |
| `power` | most capable model for the agent and task, re-evaluated each turn | next most capable |

`stop` halts the loop and selects nothing.

Every decision is a deterministic filter-and-sort over `lib/catalogue.ts`, so a
selection can always be replayed and explained. `local` sits on a different
axis from price — it is the free-mode fallback, not a tier below it — so the
degradation chain is `cheap → free`, not `cheap → free → local`.

## Per-agent selection

Ranking is adjusted per agent, because an architect and a build agent want
different things from the same catalogue:

- **architect** — vision, ≥100k context, reasoning-weighted
- **build** — ≥32k context, code-weighted
- **review** — ≥64k context, code-weighted
- **explore** — vision, ≥64k context
- **general** — ≥32k context, balanced

## Catalogue

One row per model, one row per variant where a variant changes capability or
price. Columns include context, max output, capability flags (text, image,
audio, pdf, video, reasoning, tool calling, structured, embedding), pricing,
four strength scores, availability, status, and a `deprecated` column.

`estimated: true` marks any row whose scores were derived rather than read, and
records which fields and how confident the estimate is. A strategy can prefer
confirmed data and degrade to estimates only when it must.

## Clocks

Three clocks, failing differently:

- **interval** (30s) — heartbeat. Re-plans and re-applies, which is what makes
  "continually evaluate on each turn" true even when nothing else happens.
- **idle** (10m) — a session producing no events at all is not working on
  anything; the loop stands down.
- **hang** (3m) — *not* a wall-clock timeout. It arms only while a session is
  running and disarms on **any** progress signal: a message, a token, a tool
  call, a subagent start, a reasoning delta, a permission request. A long
  task with steady output never trips it however long it runs. A session that
  is running and totally silent does.

That distinction is the point: the hang clock catches the stuck request, not
the long one. After three interrupts without recovery it stops escalating
rather than destroying work.

## Errors

Classification is regex + HTTP status, applied before any recovery path:

| Kind | Trigger | Action |
| --- | --- | --- |
| `funds` | insufficient balance / quota | cooldown 1h, degrade to a cheaper mode |
| `rate` | 429, rate limit, throttling | cooldown 1m, rotate, re-sweep |
| `capability` | model lacks a required capability | cooldown 5m, restrict the pool |
| `context` | context window exceeded | rotate to a larger-context model |
| `notfound` | model gone or deprecated | cooldown 24h, rotate past |
| `auth` | 401/403, bad key | cooldown 15m, rotate to another provider |
| `network` | timeout, reset, DNS | cooldown 15s, retry |
| `other` | unclassified | cooldown 30s, counts toward the 5-error stop budget |

A capability error pins the session to a pool that avoids the missing
capability (`no-vision`, `no-tools`, `text-only`) rather than merely cooling the
model down, because the miss is a fact about the task, not a flake.

## Commands

```
/dont-stop-set status
/dont-stop-set mode free|cheap|local|power
/dont-stop-set start <prompt>
/dont-stop-set start --prompt-file <path>
/dont-stop-set stop
/dont-stop-set probe
/dont-stop-set best-for <agent>
/dont-stop-set update-model-catalogue
/dont-stop-set track <sessionID>
```

`--prompt-file` reads the prompt from disk and errors clearly when the path is
missing or empty. Any inline text is prepended to the file's contents.

## Layout

```
index.ts            server entrypoint: command API, event pump, state watch
tui.ts              terminal entrypoint: footer status, mode cycling, toasts
lib/catalogue.ts    model rows, filters, sorts, scoring
lib/modes.ts        mode strategies and per-agent ranking
lib/errors.ts       error classification and recovery actions
lib/clocks.ts       interval / idle / hang clocks
lib/apply.ts        the two channels that reach running sessions
lib/engine.ts       loop orchestration: discover, plan, apply, rotate
lib/state.ts        durable state bridging both halves
lib/log.ts          structured logging
```

Both halves communicate only through the state file, which the server writes
atomically and the terminal watches by mtime. Either half can restart without
losing the other's view, and a change made headlessly shows up in the next
terminal.
