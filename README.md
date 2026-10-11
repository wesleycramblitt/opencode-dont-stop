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

## The loop

`dont-stop-set start <prompt>` arms a loop on a session. It is driven by the
session's own idle events, not by a timer: a turn finishes, the session goes
idle, and `advance()` decides what happens next.

```
start                      -> plan, switch model, send opening prompt
session.idle               -> advance()
  count the iteration
  read the last assistant turn
  if completion sentinel   -> stop("task complete after N iterations")
  if iteration budget spent -> stop("iteration budget reached")
  if error budget spent     -> stop("stopping after N consecutive errors")
  otherwise:
    re-plan                 -> re-rank, sweep for a better/available model, switch
    send the continue prompt -> session goes busy, hang clock re-arms
```

### Completion

The loop cannot know on its own whether a task is finished — that is a judgement
about the work, and only the entity doing it has the context. So the loop asks:
every prompt is appended with an instruction to reply with exactly
`<loop-complete/>` when, and only when, the task is genuinely done. Reading for
it is deterministic and costs no extra model call, which an "is it done?" probe
would.

Two safety bounds stop a loop whose model never emits the sentinel:
`maxIterations` (default 100) and the consecutive-error budget (5). A read
failure is treated as *not complete*, so a broken message read runs the loop to
its budget rather than halting it.

### Re-planning between turns

The re-plan before each continue prompt is what makes "continually evaluate on
each turn" true. It re-ranks the catalogue under the current mode and switches
the session if the answer changed — so a free model that becomes available is
picked up on the next turn, and a model that was cooling down is retried once
its cooldown expires.

Idle between turns is the loop's normal state, not its end: the heartbeat stops
killing the loop session on idle, and only untracks sessions that are not the
loop's.

## Context handoff

Replaces a compaction plugin. When a session has consumed enough of its model's
context window, the loop closes it and starts a fresh session seeded from a
written summary, so work continues instead of erroring out mid-prompt.

Three properties make it safe where a compaction plugin was not:

1. **Between turns, never during one.** The only entry point is the completion
   path — after the task is judged finished, before the next prompt. A handoff
   mid-turn would destroy the work in flight.
2. **It refuses while subagents are live.** A subagent is a child session;
   handing the parent off under one orphans the child's context and leaves it
   writing into a session that no longer exists. The walk is transitive —
   grandchildren count — and a deferral delays the handoff rather than losing
   it; the next turn retries.
3. **The threshold is the model's own window.** A 128k model and a 1M model do
   not hand off at the same token count, so the fraction (default 0.5) is
   applied to the context size of the model actually in use.

Context usage is read from the last assistant message's reported `tokens.input`
plus cache reads — the prompt size the provider actually measured. It is never
estimated from text length, which would be wrong by a factor of several.

The summary is written *before* the new session is created, so a write failure
leaves the original session untouched and the loop continues in place. The new
session is seeded with a pointer to the file rather than its contents, because
the point is to start with a small window.

The summary is deterministic rather than model-written: the task verbatim, the
recent turns verbatim, older turns condensed to one line each, and the files
touched (read from tool-call parts). A model-written summary would be better
prose and would have a failure mode that loses the session.

## Development

```
npx tsx scripts/update-catalogue.ts   # regenerate the catalogue
./node_modules/.bin/tsc --noEmit -p . # typecheck (excludes tui.tsx)
```

`tui.tsx` is excluded from the local typecheck because it imports
`@opencode/plugin/tui` and `@opentui/solid`, which the opencode server provides
at runtime but which are not installable standalone. `opencode-voice` takes the
same approach.

## Reachability

models.dev catalogs 226 providers, but an install can reach only the ones it
holds credentials for. Ranking over the whole catalogue therefore selects models
that cannot be used: `alibaba/qwen3.7-flash` is the cheapest text+tool model in
models.dev and is unroutable without an Alibaba key.

Two checks, in layers:

1. **At fetch time** — `reachableModels()` shells out to `opencode api get
   /api/model`, which carries the credentials (a plain HTTP fetch to the
   server's port returns 401). Unroutable rows are persisted with
   `reachable: false`.
2. **At load time** — the engine re-derives it from `ctx.catalog.model.list()`,
   because the committed file goes stale when credentials change. A failure to
   list leaves reachability untouched rather than clearing it, so a transient
   API error cannot empty every mode.

`meets()` rejects `reachable === false`, so no mode can select one.

To make more models reachable, add the provider: `opencode auth login`, or add
its credentials to `~/.local/share/opencode/auth.json`.

## Local means runnable here

`local` is not "listed on ollama.com". A model is a local candidate only when:

- the ollama daemon **has it pulled** (`/api/tags`), and
- it is **not tagged `cloud`** — ollama.com tags remotely-hosted models
  `cloud`, and those are rented compute, and
- its **total parameter count fits the GPU** at the default pull quantization.

Sizing uses *total* parameters because that is what must be resident:
`nemotron-3.5-lightning` is 30B total with 3B active, so it needs ~20.5GB of a
4090's ~21GB usable budget despite behaving like a 3B model. Capability, by
contrast, is derived from *active* parameters — conflating the two is what makes
a small-effective MoE model look like a frontier one.

Models whose weights are unpublished are excluded from local mode rather than
assumed to fit. An unknown may or may not load, and promising it is how a user
ends up with an out-of-memory error mid-loop.

Adjust the target card with `HARDWARE_4090` in `lib/catalogue.ts`.

## Parameter weights

`weights` is stored as total and active, separately, because they answer
different questions. Parsed from three sources, most authoritative first:

1. the **pull tag** on an installed model — `ollama pull qwen3-vl:30b` names
   its size, and it outranks any scraped description
2. the **description** — "an open 30B MoE model with 3B active parameters",
   "activates 52B of 1.05T total parameters", "a 421M decision model"
3. the **tag row** — `tools thinking 0.8b 4b 81K`, taking the largest size

`M` units are honoured (421M is 0.421B). `weights.source` records which fired,
so an unexplained size can be traced.

## Terminal entrypoint

`tui.tsx` is a separate entrypoint from `index.ts` (see `package.json` `exports`).
It owns the footer status, the mode-cycling keymap, and the transition toasts.

Two things about it are load-bearing and easy to get wrong:

- **`keymap.layer` must be registered from inside a slot render, not from
  `setup`.** It reads the keymap through a reactive context, so calling it
  directly fails with `Keymap.Provider is missing` — the provider the read
  resolves against does not exist yet. An `app` slot renders inside that tree,
  so registration is deferred to its render and torn down with the slot.
- **The layer needs an explicit `mode`.** Omitting it defaults to `base`; the
  commands here are global, so the layer is registered as `mode: "global"`.

`opencode-voice` follows the same pattern and is the reference implementation.
