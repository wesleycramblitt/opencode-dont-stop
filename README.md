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

## V2 events

The engine is event-driven, so it listens to the vocabulary the running
server actually publishes. OpenCode v2 streams `{ id, created, type, data }`
with names like `session.execution.started/succeeded/failed/interrupted`,
`session.step.started`, `session.text.delta`, `session.tool.called` — there
is no V1 `properties` wrapper and no `message.*` family. `lib/events.ts` is
the only module that knows those names; it decodes an event into signals
(turn start/finish, progress, session model/agent, error) that the rest of
the plugin consumes. An unhandled event shows up as an entry missing from
that one table rather than a silent regex miss.

The loop is driven by the `session.execution.*` trio — exactly one event
per turn — rather than by `session.idle`: the idle/status events trail an
execution result and would double-advance a loop that listened to both.

## Modes

| Mode | Selects | On failure |
| --- | --- | --- |
| `free` | verified zero-cost models swept by capability, then quota-backed models, then the best local model | next untried model in that order; re-sweep when the task completes |
| `cheap` | paid models cheapest-first, then free models, then local | next untried model in that order; degrade to `free` on low funds |
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
| **Alibaba Model Studio** `/api/v1/models` | The live per-account inventory behind a key: id, name, description, features, per-model prices (standard and thinking bands, cache read/write), context window, max output, and request/response modalities. It lists models models.dev has not caught up with, so a row from it outranks a models.dev row of the same id |
| **ollama.com** search | The top 100 locally-runnable models by popularity, with context windows, parameter sizes and capability tags |
| **local ollama** `/api/tags` | What is actually installed on this machine |
| **`data/benchmarks.ts`** | Curated, cited benchmark scores keyed by canonical id |

Rows without a token price (image generation, video, TTS, ASR, embeddings)
never enter the catalogue: a row with no pricing must not be mistaken for a
free one. When two sources share a key the more authoritative row wins —
local install, then the vendor's own inventory, then models.dev, then the
popularity scrape.

### Alibaba's inventory

The Alibaba source needs a key, resolved in `resolveAlibabaKey` (in
`lib/fetch.ts`), in order: an explicit `--alibaba-key` override, the
`ALIBABA_API_KEY` / `DASHSCOPE_API_KEY` environment variables, then the
`providers.alibaba` block in `opencode.json` (V2 `settings.apiKey`, or the
legacy `options.apiKey`). With none of those, the source is skipped with a
note and the build still succeeds from models.dev. Point the source at a
dedicated workspace instead of the international endpoint with
`ALIBABA_MODELS_URL=https://ws-<id>.<region>.maas.aliyuncs.com/api/v1/models`.

Because the inventory is per account, reachability is not the source's job:
the engine re-derives it from `ctx.model.list()` at load, so only models the
running server can route to are ever selectable. A workspace model that
opencode's registry does not list yet sits in the catalogue as `reachable:
false` — visible to `probe`, excluded from every mode — until you add it to
`providers.alibaba.models` in `opencode.json`.

`ollama.com/search` is client-rendered and caps the server HTML at 20 models,
so a plain `fetch` cannot see the rest. `scripts/scrape-ollama.ts` drives a real
browser to collect the full list; the catalogue update reads the file it writes,
so the normal path stays pure network I/O.

### Free tiers

Alibaba grants accounts a per-model promotional quota — on this account,
1M tokens per language model inside 91 days, plus small generation-count
quotas for image/video models (kept out of the table entirely: they are not
token quotas, and their models are not chat models). The allowance is per
model, shown in the console, and not queryable through any public API — so
it is declared data: `data/free-tiers.ts`, keyed by `provider/model`, dated
by the snapshot it was taken from, with every entry naming its source and
whether the account currently has the model switched on.

**The table is empty as of 2026-10-12.** The overnight loop drew the grants
down model after model, and the provider refused each model it reached with
"The free quota has been exhausted" — classified `freequota`, a permanent
exclusion from the sweep. The grants are one-time (they expire 2027-01-10
and do not reset), so those models are paid rows now and the table declares
none of them. Add a line back only when the console shows an allowance
alive again.

The catalogue re-applies the table at load time, and the table is the
authority: absence means spent, so clearing a line takes effect without a
catalogue rebuild — the persisted row's copy is a snapshot of an older
table and cannot outvote it.

A quota-backed row is not priced at zero, but it is a legitimate member of
the `free` sweep: after the genuinely free rows, before the local fallback,
with the account's switched-on quotas ordered ahead of the switched-off
ones — enablement is a console setting, not a property of the model, so
both stay in the chain. When the allowance runs out, requests fail with the
free-quota error, which the classifier reads as `freequota` — the model is
excluded from the sweep for good, and leaving `free` mode is what lifts the
exclusion so the same model is selectable as a paid row.

The remaining allowance is account state the plugin deliberately does not
pretend to measure: there is no usage API, and an invented "remaining"
number would be a guess presented as a fact. The table is the contract;
edit it when the console changes.

### Updating

```
npx tsx scripts/update-catalogue.ts             # rewrite data/catalogue.json
npx tsx scripts/update-catalogue.ts --alibaba-key <key>   # key the env/config do not cover
npx tsx scripts/update-catalogue.ts --table     # also print the ranked table
npx tsx scripts/update-catalogue.ts --dry-run   # report only
npx tsx scripts/scrape-ollama.ts --limit 100    # refresh the ollama popularity list
```

The `update-model-catalogue` command does the rebuild live — fetch every
source, write `data/catalogue.json`, reload, and re-plan — because a command
is an explicit request and a heartbeat is not; the plugin never rewrites the
file on its own.

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
the long one. Interrupting is only the first step, though, and the steps after
it are where the old design spun:

- The interrupt **disarms the clock**. An aborted request never emits the
  completion event that would have disarmed it, so a clock that kept claiming
  a request was in flight re-fired every 3 minutes forever.
- The hung model goes on a 10-minute cooldown, so the chain actually moves
  instead of cycling back to the model that just hung.
- The loop **re-drives itself** 20s later, because the abort removed the idle
  event the loop is normally driven by — without that, one hang silently ended
  the loop's progress while leaving it "active".
- **Every model gets one try per turn.** Rotation moves to the best-ranked model
  that has not been attempted since the last completed turn, so the chain is
  walked once in rank order and then starts waiting instead of cycling through
  the same few forever. In `free` that means the hosted free sweep first and the
  local models after it, which is the point of having local models at all; in
  `cheap` it is paid, then free, then local. Models that are unreachable or
  cooling down are filtered out before this point, so they never consume a try.
- **A cooldown's expiry buys the model its turn back.** When a cooldown
  expires the model is not just available again but untried again, so a free
  model that was refused wins its next try *ahead* of the local tail rather
  than being locked out for the rest of the turn.
- **The loop does not stop itself** (owner, 2026-10-11). The iteration budget,
  the consecutive-error budget, an exhausted chain, repeated interrupts and a
  completion claim are all *reported*, never terminal: the loop waits for
  cooldowns, keeps re-driving, rotates to a fresh session when due, and ends
  only on a halt.

Hang recovery only ever touches the session the loop is driving. Any other
session — including the user's own — is never interrupted or re-modelled by
this plugin.

## Errors

Classification is regex + HTTP status, applied before any recovery path, with
the provider's **message itself as the strongest signal** — a provider error
*type* or a wrapped status is coarser than the sentence, and were both
observed calling a rate limit a *funds* error, which bought a mode degrade
instead of a rotation. The `retry` column is one retry **per model per turn**,
and only for failures that could plausibly clear on their own — a dropped
connection, an unclassified error — and **only outside the free sweep**: the
free-mode policy (owner, 2026-10-11) is one try per endpoint, an hour out
of the sweep after any failure, and a spent promotional quota out **forever**.

| Kind | Trigger | Retry | Action (base) | In `free` mode |
| --- | --- | --- | --- | --- |
| `interrupted` | our own interrupt, a user escape, a cancelled request | — | nothing: not a failure, no cooldown, no rotation | same |
| `funds` | insufficient balance / quota (opencode and alibaba phrasings), arrears | no | cooldown 1h; degrades a mode **only when two different providers are both out of money** (a single provider out rotates) | cooldown 1h, degrade is a no-op at the floor |
| `freequota` | "The free quota has been exhausted…" (alibaba promotional allowance) | no | cooldown 1h, rotate | **permanent** exclusion from the sweep (lifted when the mode leaves `free`) |
| `rate` | 429, rate limit, throttling | no | cooldown 1m, rotate, re-sweep | cooldown 1h |
| `capability` | model lacks a required capability | no | cooldown 5m, restrict the pool | cooldown 1h |
| `context` | context window exceeded | no | rotate to a larger-context model | cooldown 1h |
| `state` | "reasoning item … was not found or has expired" — the transcript references provider state the endpoint no longer holds | no | **compact the transcript, then re-drive**; rotate only if compaction is already rate-limited | same (no cooldown: the model is not at fault) |
| `notfound` | model gone or deprecated | no | cooldown 24h, rotate past | same |
| `deprecated` | "…has been deprecated…" — the provider retires the row | no | **permanent** in every mode; nothing lifts it | same |
| `auth` | 401/403, bad key | no | cooldown 15m, rotate to another provider | cooldown 1h |
| `network` | timeout, reset, DNS | yes | cooldown 15s, retry | no retry, cooldown 1h |
| `other` | unclassified | yes | cooldown 30s | no retry, cooldown 1h |

**A retry storm is cut short, not watched.** opencode's own client retries a
failed request ("retrying in 5s attempt 2…") — up to five attempts that can
take a minute, during which the failing model stays in use and the hang
clock was never disarmed, because a retry is activity, not progress. When
the loop's session schedules a retry in `free` mode, the engine classifies
the retry's own error, interrupts the turn (the storm never happens),
cooldowns the model per the policy above, rotates, and re-drives on the
next untried model. Paid modes let opencode's retries finish: a blip on a
model you are paying for usually recovers, and a second chance belongs in
the paid chain.

`interrupted` leads the pattern list on purpose. The loop's own hang recovery
produces exactly this error — "tool interrupted" — and scoring it as an
unclassified failure is what sent recovery into a spin: one interrupt bought a
rotation, the rotation got interrupted, and the loop paid for its own
recovery.

### Free-model cooldown

A free model that fails once is not tried again for an hour — `freequota`
models never return, because a spent promotional quota does not come back with
a timeout. A deprecated model never returns either, in any mode, and no mode
change revives it. Only `funds` moves a mode (cheap → free, staying there
until the user brings the mode back — a key error rotates instead of
degrading). The local fallback is the recovery when the whole sweep is
cooling: the free chain's tail is the local models, and cooling rows are
filtered out of the ranking before rotation sees them, so a cooled-out sweep
hands the turn to ollama instead of stopping.

In `cheap` mode the chain is the paid rows cheapest-first — today that is
`alibaba/qwen3.7-flash` ($0.03 input) ahead of `qwen-turbo` / `qwen-flash`
($0.05), then `opencode/deepseek-v4-flash` ($0.14) — then the free tail, then
local. A failure rotates to the next cheapest untried row; the mode itself
only changes on insufficient funds, and then only when **both** paid
providers are out — `fundsProviders` in the state file records which
providers reported it, and a mark older than 24h stops counting (an account
that was topped up is not a second provider). Until the bar is met, a funds
failure is a cooldown and a rotation like any other.

A capability error pins the session to a pool that avoids the missing
capability (`no-vision`, `no-tools`, `text-only`) rather than merely cooling the
model down, because the miss is a fact about the task, not a flake.

## Commands

```
/dont-stop-set status
/dont-stop-set mode free|cheap|local|power [sessionID]
/dont-stop-set start <prompt>
/dont-stop-set start --prompt-file <path>
/dont-stop-set stop [sessionID]
/dont-stop-set probe
/dont-stop-set best-for <agent>
/dont-stop-set update-model-catalogue
/dont-stop-set track <sessionID>
```

`status` lists one block per loop — session, status, owner, iterations,
rotations, its own mode (and the mode it degraded from), prompt and last
result. `stop` without a session halts every loop this instance drives; with
a session id it halts that one. `mode` without a session changes the default
mode and the primary loop; with a session id it changes that loop only.

`--prompt-file` reads the prompt from disk and errors clearly when the path is
missing or empty. Any inline text is prepended to the file's contents.

`start` with no prompt restarts the most recent loop with its stored prompt —
the same full /dont-stop command the original run opened with — so a restarted
(or fresh) session lands back on the loop with one verb. A loop session that
is restarted while active is detected on the heartbeat (its message count
drops) and re-seeded with the full prompt automatically — except within a
90-second boot window, where opencode's own SessionRestart is already resuming
sessions and a re-seed would duplicate that resume.

Rotations and re-plans only move the loop onto a model whose context window
can hold the conversation it is about to receive: a candidate too small for
the session's current usage is skipped, and when nothing fits, the session is
compacted first (transcript down, work untouched) before the switch.

`update-model-catalogue` rebuilds the catalogue from the live sources —
models.dev, the local ollama daemon, and Alibaba's inventory when a key is
resolvable — writes `data/catalogue.json`, then reloads and re-plans. The
equivalent CLI step is `npx tsx scripts/update-catalogue.ts`, which adds
`--dry-run`, `--table`, and `--alibaba-key`.

**The catalogue also refreshes itself** (owner, 2026-10-12): when
`data/catalogue.json` is older than 24 hours the heartbeat rebuilds it from
the same sources, reloads it, and re-applies the plan — so new free rows,
price changes and retirements reach the loop with no manual command. The
file's mtime is the clock and a successful refresh rewrites the file, so the
check needs no extra state; a failed fetch (network down, a source error)
keeps the current catalogue and waits 15 minutes before the next attempt —
not the next beat, because a source down for an hour must not be hammered
120 times. One fetch runs at a time. `DONT_STOP_CATALOGUE_REFRESH_HOURS`
overrides the 24h cadence.

The in-server refresh **skips the registry subprocess** on purpose. Reading
reachability means spawning `opencode api get /api/model` with `execFileSync`,
which blocks the caller's event loop — and that CLI has to talk back to the
very server it runs in, so in-server it is a self-deadlock: the server cannot
answer while it waits, the CLI declares the background service unresponsive,
and its recovery restarts the service mid-refresh (the observed restart loop:
sessions reload, instructions update, nothing progresses). The heartbeat
passes `registry: false` and lets `applyReachability` re-derive reachability
from `ctx.model.list()` in-process, which it already does at load. The
standalone `scripts/update-catalogue.ts` is not the server, so it still reads
the registry.

Alibaba's inventory is the one source a refresh does not improve without a
key — the declared free-tier table (`data/free-tiers.ts`) is still the
authority for quota-backed rows.

## Disabling

Three switches, from strongest to weakest:

1. **Env var — `DONT_STOP_DISABLED=1`** (any value other than "" / "0").
   Honored by both halves at load with **no restart**: the server half loads
   inert (no engine, no watcher, no command surface, no model can move) and
   the terminal half renders a plain `◍ dont-stop off` footer. This is the
   switch that "the plugin is still switching my models" reaches for, because
   removing the plugin from `plugins` in opencode.json only takes effect when
   the server next restarts.
2. **Remove from `plugins`** in `~/.config/opencode/opencode.json`, then
   `opencode service restart`. The plugin then does not load at all.
3. **`dont-stop: stop loop`** (command palette) or
   `/dont-stop-set stop` — halts the loop but leaves the plugin loaded and
   ready to start another on request.

The state file (`~/.config/opencode/dont-stop-state.json`, written
atomically and only when content actually changed — identical writes are
skipped, because a write that feeds its own watcher churns the UI) reports
what the plugin is doing at any moment; the footer is always visible and
**reactive** (a Solid signal re-renders it on every state change, including a
quiet mode switch), and it shows the loop of the session you are in when that
session has one, else the newest loop. A stopped loop reads `◍ free idle`
instead of vanishing.

## Layout

```
index.ts            server entrypoint: command API, event pump, state watch
tui.ts              terminal entrypoint: footer status, mode cycling, toasts
lib/events.ts       the OpenCode v2 event vocabulary, decoded into signals
lib/catalogue.ts    model rows, filters, sorts, scoring
lib/modes.ts        mode strategies and per-agent ranking
lib/errors.ts       error classification and recovery actions
lib/clocks.ts       interval / idle / hang clocks
lib/apply.ts        the two channels that reach running sessions
lib/engine.ts       loop orchestration: discover, plan, apply, rotate
lib/rotation.ts     session rotation: measure context, walk the tree, seed the successor
lib/state.ts        durable state bridging both halves
lib/log.ts          structured logging
lib/fetch.ts        source fetching (models.dev, ollama, alibaba) and scoring
data/free-tiers.ts  declared promotional free allowances, keyed by provider/model
scripts/test.ts     unit tests
```

Both halves communicate only through the state file, which the server writes
atomically and the terminal watches by mtime. Either half can restart without
losing the other's view, and a change made headlessly shows up in the next
terminal.

The file carries two kinds of field and they are not written the same way.
Everything the engine reports is a *status*: last-write-wins, because any
writer's copy is as good as another's. The `intent` is a *control message*:
it carries a sequence number and writers merge it by that number, so an
instruction survives the race with the status writes around it.

## The loop

`dont-stop-set start <prompt>` arms a loop on a session. Loops are **per
session** (owner, 2026-10-12): several sessions can run their own loops at
once, each with its own mode, iterations and model chain, and one session's
halt or mode change never touches another's. The state file keys them by
session (`state.loops`); a `start` on a session that already has a loop merely
restarts it. A loop is driven by <p>its</p> session's own turn boundaries — the
v2 `session.execution.*` events — not by a timer: a turn finishes, and
`advance()` decides what happens next.

```
start                      -> plan, switch model, send opening prompt
session.execution.*        -> advance()  (only in the owning instance)
  count the iteration and the session's turn
  if the turn completed    -> reset the try budget (models tried, failures)
  if the turn merely errored into idleness, the budget survives it
  if the step budget is hit -> compact the transcript (work untouched)
  re-plan                  -> re-rank, sweep for a better/available model, switch
  send the next prompt     -> session goes busy, hang clock re-arms; most turns
                              get a short nudge, and every N turns (and right
                              after a compaction) the full mission is restated
```

### Ownership and halting

Several opencode processes can be open at once, and each loads this plugin.
So every loop records the **instance** that started it and only that instance
advances, interrupts or rotates it. Everywhere else the loop is reported, not
driven — which is why opening a new opencode no longer resumes a loop that was
running somewhere else.

Two mechanisms enforce it:

- **Owner heartbeat.** The owning instance stamps each loop's `ownerBeatAt`
  every beat. Three missed beats means the owner is gone. On the heartbeat an
  orphaned loop is halted on the spot rather than inherited: a loop is a
  conversation with requests in flight in another process, and it cannot be
  resumed by whoever reads the file next. **Boot is the exception.** A service
  restart kills the owner without its teardown, and the sessions themselves
  survive in the shared store — so on load, an active loop with a stale owner
  is *recovered*: the new instance adopts it and schedules a re-drive, which
  stands down if opencode's own resume is already running the turn. A loop
  whose session cannot be read at all is still halted. Halting every restart
  orphan is what turned "the server restarted" into "the loop silently ended".
- **Intent, not status.** Halting goes through `state.intent`, a control
  message carrying a sequence number. Every writer merges intents by that
  number, so a halt survives a heartbeat rewriting the rest of the file — the
  lost update that used to make `/dont-stop-halt` announce a stop that never
  took. The heartbeat also re-reads the intent, so the worst case for "stop
  now" is one 30s beat even when the file watcher loses the race.
- **Halts bound the named session.** `stop <sessionID>` ends that one loop;
  a halt with no session (the palette command, a teardown, an intent) ends
  every loop the instance drives. Modes are per loop too: `mode <name>
  [sessionID]` changes one session's loop mode (or, without a session, the
  default mode plus the primary loop), and degradation after insufficient
  funds moves only the loop that failed.

`stop()` always cancels the in-flight turn and drops the session's clocks,
even when the status already reads "stopped": that cleanup is what actually
ends the interrupt-and-rotate cycle, and skipping it (as it once did) left the
behaviour running behind a status that said otherwise.

**A halt reaches the whole tree.** The loop's session can spawn subagents,
and those are child sessions that keep working after the parent has stopped.
`stop()` — and the hang recovery's interrupt — walk the session tree (root
first, descendants transitively, one `parentID`-filtered page per level so a
wide fan-out cannot be truncated away) and interrupt every live member.
Only running sessions are interrupted; the rest only lose their clocks.
Descendants are then untracked, so no later beat re-kindles them, while the
loop's own session stays tracked so a later `start` can find it.

### Completion and boundaries

There is no completion protocol. The loop does not ask the model to declare
anything, reads no sentinel tokens, and nothing a model says can end it: a loop
ends only when its owner halts it (owner, 2026-10-12). Models get completion
judgements wrong (one declared a review-and-build sweep complete after
compiling task files but before building anything), and an oracle token only
invited a model that had lost the mission to park on it.

Instead the loop **keeps the mission in front of the model**. Most turns get a
short nudge ("Continue."); every `reinjectEvery` turns (10 by default), and
immediately after a step-budget compaction, the full opening prompt is
restated. That is what fixes the "finished a few tasks and sat still" failure:
the opening instructions age out of attention and compaction summarizes them
away, so the one guaranteed-fresh message is the one that carries the mission.

Nothing is terminal: the iteration budget, the consecutive-error budget, an
exhausted chain and three interrupts are all reported but never stop — the
loop waits for cooldowns, re-drives, and keeps working. `stop` — the halt
command, the TUI key, the intent — is the one way out.

### Re-planning between turns

The re-plan before each continue prompt is what makes "continually evaluate on
each turn" true. It re-ranks the catalogue under the current mode and switches
the session if the answer changed — so a free model that becomes available is
picked up on the next turn, and a model that was cooling down is retried once
its cooldown expires.

Idle between turns is the loop's normal state, not its end: the heartbeat stops
killing the loop session on idle, and only untracks sessions that are not the
loop's.

## Session rotation

A loop that runs for hours degrades: a long conversation makes the model worse
at the work, not just slower, and a fresh session with the same prompt cures it.
So the loop retires its session and starts a new one — an empty conversation
with no carried-over history, no tool calls, and no summary. The repository is
the state (plans, task files, results on disk), and the seed prompt says so —
while telling the successor to re-establish the work with *minimal* reading:
the session that just retired filled its window, so a fresh session that
re-reads everything wholesale would fill its own window in one turn and retire
without producing work. This replaces the summary-based handoff, which existed
only to bridge the two sessions; a session that already wrote its work to disk
does not need bridging.

Two things trigger a rotation:

1. **A session step budget.** 30 turns in one session. This is the backstop
   for a model that never settles.
2. **Context pressure.** Usage at 80% of the effective window. This is not the
   emergency mechanism — OpenCode's own auto-compaction is the backstop for
   that — it is what keeps the backstop theoretical. It matters most for the
   local fallback, where OpenCode's model metadata (a 3.5M native window) does
   not match what the daemon serves (64k), so auto-compaction would not fire.

The architect's free-mode chain leads with `qwen3.5:9b-ctx256k`, a local
variant whose Modelfile bakes `num_ctx 262144`, with `qwen3-coder:30b-ctx256k`
(a same-window variant) as the capable fallback: the ollama daemon serves the
plain tags at `OLLAMA_CONTEXT_LENGTH` (64k here), which would retire an
architect session after one turn, and a 30B at 262k is tight on a 24GB card —
the 9B serves the same window for a fraction of the VRAM. The engine measures
the window `/api/ps` actually reports, so the baked parameter is what the
rotation threshold (0.8 × served) uses.

Three properties make rotation safe:

1. **Between turns, never during one.** The only entry point is the completion
   path — the turn has ended, its work is on disk, and no request is in flight.
2. **It refuses while subagents are live.** A subagent is a child session;
   rotating the parent under one orphans the child's context and leaves it
   writing into a session that no longer exists. The walk is transitive —
   grandchildren count — and a deferral is remembered and retried on the next
   turn rather than lost.
3. **The threshold is the window the session can actually use.** A 128k model
   and a 1M model do not rotate at the same token count, so the fraction
   (default 0.8) is applied to the context size of the model actually in use.
   For a local model that size is asked of the ollama daemon (`/api/ps`)
   rather than taken from the catalogue: the catalogue records the
   architecture's native window, while the daemon serves whatever
   `OLLAMA_CONTEXT_LENGTH` says and truncates the prompt to fit. Measuring
   against the native figure is how a loop stalls — every turn comes back cut
   off and the threshold never arrives.

Context usage is read from the last assistant message's reported `tokens.input`
plus cache reads — the prompt size the provider actually measured. It is never
estimated from text length, which would be wrong by a factor of several.

The loop record moves to the successor: `iterations` is the loop's and carries,
while `sessionIterations` — the freshness metric in the footer — starts over.
The retired session is deleted once its successor is seeded (its subagent
sessions go with it, recursively); a failed deletion is reported in the log
and the session stays behind, intact and idle.

The successor is named for the work and its place in the run: the first
substantial line of the loop prompt — skipping a leading `mode …` line — cut
to ~70 characters, then ` · loop N`. A loop whose prompt names its task
produces sessions like "Task 1 changing the widget · loop 3", where N comes
from a `sessionNumber` carried on the loop record.

The terminal follows the rotation: a TUI that was showing the loop's session
switches to the successor (focused as a tab when tabs are enabled, a route
change otherwise), so a watching terminal is never left staring at a retired
conversation. Terminals on other sessions are untouched — only the terminal
that was actually watching the loop moves, and the loop's `rotatedFrom`
record is what says which session it left.

## Context windows and hardware

A local model's window is configured in three layers, and the plugin measures
whatever the daemon actually serves:

1. **Daemon default.** `OLLAMA_CONTEXT_LENGTH` (64,000 here, in the ollama
   unit's environment) is the window every *plain* tag serves.
2. **Per-model variants.** A Modelfile bakes a larger window into a model
   (`PARAMETER num_ctx 262144`), installed as its own tag
   (`ollama create qwen3.5:9b-ctx256k -f Modelfile`). The baked parameter
   overrides the daemon env and is clamped at the model's native window — the
   exact served figure shows up in `/api/ps`.
3. **The plugin's rotation threshold.** `contextLimitFor` reads `/api/ps` for
   the loaded model; the loop rotates at 0.8 × the served window. Whatever a
   model actually serves is what the loop uses — no window guessing.

Two per-machine knobs keep the same code right on different machines:

- **`DONT_STOP_VRAM_GB`** (e.g. `DONT_STOP_VRAM_GB=8` in the service
  environment) sizes the local fit checks to the card's VRAM — any GPU,
  only the VRAM number matters. Agent leads and the local-mode ranking skip
  rows that cannot load (weights + reserve > 0.88 × VRAM), and the default
  falls back to 24 GB (a 4090-class card).
- **The catalogue is per-machine**: `npx tsx scripts/update-catalogue.ts`
  merges the local ollama daemon's installed tags, so each machine's
  catalogue reflects its own models. Since `AGENT_LEADS` and the ranking skip
  rows that are absent **or do not fit**, one ordered lead list works
  everywhere: a small card falls through the big-window leads to the variants
  that fit it. A variant that serves more than it should wastes a load
  attempt at worst — the daemon refuses a window that does not fit.

## Development

```
npx tsx scripts/test.ts                    # unit tests (no server, no network)
npx tsx scripts/update-catalogue.ts        # regenerate the catalogue
./node_modules/.bin/tsc --noEmit -p .      # typecheck (excludes tui.tsx)
```

The tests cover the parts with the most sharp edges: the v2 event mapping,
the clocks (a long quiet-but-progressing turn never trips the hang clock, an
interrupt disarms it), the error table, the free/quota/local ranking, the
alibaba shape parsing, and the engine's loop rules — rotation walks the chain
once, the turn arm prevents a double advance, halt interrupts the tree, a
foreign session's errors never stop a loop. They run through a fake plugin
context, so nothing in them can touch a live session.

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
2. **At load time** — the engine re-derives it from `ctx.model.list()` (with
   the older `ctx.catalog.model.list()` spelling tolerated), because the
   committed file goes stale when credentials change. A failure to list
   leaves reachability untouched rather than clearing it, so a transient API
   error cannot empty every mode.

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

Three things about it are load-bearing and easy to get wrong:

- **`keymap.layer` must be registered from inside a slot render, not from
  `setup`.** It reads the keymap through a reactive context, so calling it
  directly fails with `Keymap.Provider is missing` — the provider the read
  resolves against does not exist yet. An `app` slot renders inside that tree,
  so registration is deferred to its render and torn down with the slot.
- **The layer needs an explicit `mode`.** Omitting it defaults to `base`; the
  commands here are global, so the layer is registered as `mode: "global"`.
- **`dont-stop-halt` writes an intent, not a status.** The engine rewrites the
  loop's status on every heartbeat, so a terminal that wrote
  `loop.status = "stopped"` was racing a writer that could not see it. The
  footer shows `halting…` while the request is pending, because the status
  legitimately still reads `active` until the owning instance applies it.

`opencode-voice` follows the same pattern and is the reference implementation.
