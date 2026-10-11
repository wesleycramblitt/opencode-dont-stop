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

The catalogue is a **data table**, not an algorithm. Rows are fetched from real
sources and persisted to `data/catalogue.json`, which is loaded read-only at
runtime — so the catalogue is reproducible, reviewable in a diff, and needs no
network access at plugin load time.

### Sources

| Source | What it provides |
| --- | --- |
| **models.dev** `/api.json` | The authoritative registry: capabilities, modalities, limits, pricing, knowledge cutoff, release date, and the `canonical_model_id` linking every provider alias to one identity |
| **ollama.com** search | The top 100 locally-runnable models by popularity, with context windows, parameter sizes and capability tags |
| **local ollama** `/api/tags` | What is actually installed on this machine |
| **`data/benchmarks.ts`** | Curated, cited benchmark scores keyed by canonical id |

`ollama.com/search` is client-rendered and caps the server HTML at 20 models,
so a plain `fetch` cannot see the rest. `scripts/scrape-ollama.ts` drives a real
browser to collect the full list; the catalogue update reads the file it writes,
so the normal path stays pure network I/O.

### Updating

```
npx tsx scripts/update-catalogue.ts             # rewrite data/catalogue.json
npx tsx scripts/update-catalogue.ts --table     # also print the ranked table
npx tsx scripts/update-catalogue.ts --dry-run   # report only
npx tsx scripts/scrape-ollama.ts --limit 100    # refresh the ollama popularity list
```

The `update-model-catalogue` command reloads the generated file and re-plans.
Rebuilding the file is a deliberate CLI step, not something a plugin reload
does: it is slow, network-bound, and produces a committed artifact.

### Provenance

Two rules keep a derived ranking honest:

1. **`verified`** is true only when a column came from a source. Anything
   derived is stored with `provenance.estimated: true` and the derived fields
   listed, so a ranking made on a guess is distinguishable from one made on a
   report.
2. **Score floors bind only verified rows.** An estimated score is a prior
   derived from price and metadata, so excluding on it would remove most of the
   catalogue over a guess. Capability and context floors bind everywhere:
   those are facts.

### Scoring

Reported benchmarks are calibrated onto the 0-10 scale through a curve
(`calibrateBenchmark`), not by dividing by ten. Benchmark values cluster in
60-90%, so a linear `/10` maps the useful range into 6-9 and leaves real reports
scoring *below* metadata estimates that span 2-10 — the inversion would make a
published report lose to a guess. An axis with no reported column falls back to
the derived value *for that axis*, so a missing benchmark is a gap rather than a
zero.

Derived axes are weighted sums of continuous sourced signals:

| Axis | Dominant signals |
| --- | --- |
| code | price / parameter count, recency, family generation, tier tokens |
| reasoning | price / parameter count, reasoning flag, recency |
| agentic | tool calling, structured output, parameter count |
| general | knowledge cutoff, modality breadth, recency |

**Price** is the vendor's own statement of tier and dominates remote rows;
**parameter count** is the equivalent statement for a local model and dominates
there, since a 120B MoE is not in the same class as a 4B dense one. **Context is
deliberately a minor term** — it measures capacity, not ability, and weighting it
heavily is what ranks a 24B model above a frontier one.

Known limitation: benchmarks differ in difficulty. SWE-bench 80% is far harder
than MATH-500 98%, and the calibration does not correct for that. It is a
documented uniform approximation, not a claim the evals are equivalent.

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

## Development

```
npx tsx scripts/update-catalogue.ts   # regenerate the catalogue
./node_modules/.bin/tsc --noEmit -p . # typecheck (excludes tui.tsx)
```

`tui.tsx` is excluded from the local typecheck because it imports
`@opencode/plugin/tui` and `@opentui/solid`, which the opencode server provides
at runtime but which are not installable standalone. `opencode-voice` takes the
same approach.
