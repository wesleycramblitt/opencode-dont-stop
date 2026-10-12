#!/usr/bin/env -S npx tsx
/**
 * dont-stop unit tests.
 *
 * Pure modules first (events, clocks, errors, catalogue, handoff, the alibaba
 * shape), then the engine's loop logic through a fake plugin context — no
 * network, no server, and nothing that can touch a live session.
 *
 *   npx tsx scripts/test.ts
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { eventSignals } from "../lib/events.ts"
import { SessionClocks } from "../lib/clocks.ts"
import { classify, actionFor, DEPRECATED_COOLDOWN_MS, PERMANENT_COOLDOWN_MS } from "../lib/errors.ts"
import { meets, loadCatalogue, type Catalogue, type CatalogueModel } from "../lib/catalogue.ts"
import { rankForMode, profileFor } from "../lib/modes.ts"
import { measureContext, transcriptFrom, descendantIDs, buildSummary } from "../lib/handoff.ts"
import { catalogueRefreshDue, parseAlibabaInventory, rowsFromAlibaba, resolveAlibabaKey } from "../lib/fetch.ts"
import { LoopEngine, COMPLETION_SENTINEL } from "../lib/engine.ts"
import { initialState, readState, type Mode, type PluginState } from "../lib/state.ts"
import { FREE_TIERS } from "../data/free-tiers.ts"

/* ------------------------------------------------------- v2 event vocabulary */

test("eventSignals reads v2 payloads from `data`", () => {
  const signals = eventSignals({ type: "session.step.started", data: { sessionID: "ses_a", agent: "build", model: { providerID: "opencode", id: "m" } } })
  assert.equal(signals.sessionID, "ses_a")
  assert.equal(signals.progress, "step")
  assert.equal(signals.agent, "build")
  assert.deepEqual(signals.model, { providerID: "opencode", id: "m" })
})

test("turn starts and finishes map to lifecycle", () => {
  assert.equal(eventSignals({ type: "session.execution.started", data: { sessionID: "ses_a" } }).lifecycle, "start")
  assert.equal(eventSignals({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } }).lifecycle, "finish")
  assert.equal(eventSignals({ type: "session.execution.failed", data: { sessionID: "ses_a" } }).lifecycle, "finish")
  assert.equal(eventSignals({ type: "session.execution.interrupted", data: { sessionID: "ses_a" } }).lifecycle, "finish")
  assert.equal(eventSignals({ type: "session.idle", data: { sessionID: "ses_a" } }).lifecycle, "finish")
  assert.equal(eventSignals({ type: "session.status", data: { sessionID: "ses_a", status: "busy" } }).lifecycle, "start")
  assert.equal(eventSignals({ type: "session.status", data: { sessionID: "ses_a", status: "idle" } }).lifecycle, "finish")
})

test("progress kinds come from the v2 families", () => {
  const cases: Array<[string, string]> = [
    ["session.text.delta", "token"],
    ["session.reasoning.delta", "reasoning"],
    ["session.tool.called", "tool"],
    ["session.tool.input.started", "tool"],
    ["permission.asked", "permission"],
    ["session.usage.updated", "step"],
    ["session.inbox.delivered", "message"],
  ]
  for (const [type, kind] of cases) {
    assert.equal(eventSignals({ type, data: { sessionID: "s" } }).progress, kind, type)
  }
})

test("errors are only attached to events that carry one", () => {
  const failure = eventSignals({
    type: "session.execution.failed",
    data: { sessionID: "ses_a", error: { message: "quota exceeded", status: 429, type: "provider.rate-limited" } },
  })
  assert.deepEqual(failure.error, { message: "quota exceeded", status: 429, type: "provider.rate-limited" })

  const success = eventSignals({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
  assert.equal(success.error, null)
})

test("nested AI-SDK error shapes decode", () => {
  const signals = eventSignals({ type: "session.error", data: { sessionID: "s", error: { name: "provider.invalid-request", data: { message: "context window exceeded" } } } })
  assert.equal(signals.error?.message, "context window exceeded")
  assert.equal(signals.error?.type, "provider.invalid-request")
})

test("a scheduled retry is not progress, but carries the failure that caused it", () => {
  const signals = eventSignals({ type: "session.retry.scheduled", data: { sessionID: "s", attempt: 2, error: { message: "upstream request failed", type: "provider.error", status: 502 } } })
  assert.equal(signals.progress, null)
  assert.equal(signals.lifecycle, null)
  assert.deepEqual(signals.error, { message: "upstream request failed", type: "provider.error", status: 502 })
})

test("session metadata events feed tracking without touching clocks", () => {
  const created = eventSignals({ type: "session.created", data: { sessionID: "ses_new", agent: "general", model: { providerID: "alibaba", id: "qwen3.7-flash" } } })
  assert.equal(created.lifecycle, null)
  assert.equal(created.progress, null)
  assert.equal(created.model?.id, "qwen3.7-flash")
})

/* --------------------------------------------------------------------- clocks */

const CLOCK_OPTIONS = { intervalMs: 30_000, idleMs: 600_000, hangMs: 180_000 }

test("a running session with steady progress never trips the hang clock", () => {
  const clocks = new SessionClocks("s", CLOCK_OPTIONS, 0)
  clocks.start(0)
  for (let t = 30_000; t <= 10 * 60_000; t += 30_000) clocks.progress(t)
  assert.equal(clocks.verdict(600_000).action, "wait")
})

test("a running and silent session is hung, not idle", () => {
  const clocks = new SessionClocks("s", CLOCK_OPTIONS, 0)
  clocks.start(0)
  assert.equal(clocks.verdict(181_000).action, "hang")
})

test("an interrupt disarms the hang clock instead of re-firing forever", () => {
  const clocks = new SessionClocks("s", CLOCK_OPTIONS, 0)
  clocks.start(0)
  clocks.interrupted(181_000)
  assert.equal(clocks.activity.running, false)
  assert.equal(clocks.exhausted(), false)
  // No new turn has started, so it is not hung again either.
  assert.equal(clocks.verdict(400_000).action, "wait")
  clocks.start(400_000)
  assert.equal(clocks.verdict(400_001).action, "wait")
})

test("repeated interrupts escalate to exhausted", () => {
  const clocks = new SessionClocks("s", CLOCK_OPTIONS, 0)
  for (let i = 0; i < 3; i++) {
    clocks.start(i * 10_000)
    clocks.interrupted(i * 10_000 + 1)
  }
  assert.equal(clocks.exhausted(), true)
})

test("finishing a turn resets the hang budget", () => {
  const clocks = new SessionClocks("s", CLOCK_OPTIONS, 0)
  clocks.start(0)
  clocks.interrupted(181_000)
  assert.equal(clocks.activity.hangs, 1)
  clocks.start(200_000)
  clocks.finish(500_000)
  assert.equal(clocks.exhausted(), false)
})

/* --------------------------------------------------------------------- errors */

test("classification reads status and message", () => {
  assert.equal(classify({ status: 429, message: "" }).kind, "rate")
  assert.equal(classify({ message: "insufficient balance on the account" }).kind, "funds")
  assert.equal(classify({ message: "tool interrupted" }).kind, "interrupted")
  assert.equal(classify({ message: "ECONNRESET while streaming" }).kind, "network")
})

test("the message outranks a mislabeled type or status", () => {
  // Observed in the wild: "Rate limit exceeded. Please try again later." was
  // read as a *funds* error through a wrapped status, which degraded a mode
  // instead of rotating. The provider's own sentence wins.
  assert.equal(classify({ message: "Rate limit exceeded. Please try again later.", status: 402 }).kind, "rate")
  assert.equal(classify({ message: "The free quota has been exhausted: qwen3-turbo", status: 402 }).kind, "freequota")
})

test("free-mode failures: one try, one day out, spent quotas out forever", () => {
  const rate = actionFor(classify({ message: "rate limit reached" }), "free")
  assert.equal(rate.resweep, true)
  assert.equal(rate.retry, false)
  assert.equal(rate.cooldownMs, 24 * 60 * 60 * 1000)

  const network = actionFor(classify({ message: "fetch failed" }), "free")
  assert.equal(network.retry, false)
  assert.equal(network.cooldownMs, 24 * 60 * 60 * 1000)

  const quota = actionFor(classify({ message: "The free quota has been exhausted" }), "free")
  assert.equal(quota.retry, false)
  assert.equal(quota.cooldownMs, PERMANENT_COOLDOWN_MS)
  assert.equal(quota.degrade, false)
})

test("outside the free sweep the base actions stand, and freequota rotates", () => {
  const funds = actionFor(classify({ message: "insufficient funds" }), "cheap")
  assert.equal(funds.degrade, true)
  assert.equal(funds.retry, false)

  const network = actionFor(classify({ message: "fetch failed" }), "cheap")
  assert.equal(network.retry, true)
  assert.equal(network.degrade, false)

  const quota = actionFor(classify({ message: "The free quota has been exhausted" }), "cheap")
  assert.equal(quota.retry, false)
  assert.equal(quota.degrade, false)
  assert.equal(quota.cooldownMs, 60 * 60 * 1000)
})

test("a deprecated model is out of every mode, permanently", () => {
  const deprecated = actionFor(classify({ message: "model has been deprecated" }), "cheap")
  assert.equal(deprecated.retry, false)
  assert.equal(deprecated.cooldownMs, DEPRECATED_COOLDOWN_MS)
  assert.equal(deprecated.degrade, false)
  // The free-mode floor does not soften it: a day out is weaker than forever.
  const free = actionFor(classify({ message: "the model is deprecated" }), "free")
  assert.equal(free.cooldownMs, DEPRECATED_COOLDOWN_MS)
})

test("leaving free mode lifts spent quotas but never deprecated models", async () => {
  const { engine, state } = makeEngine("i1")
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x" }),
    row({ key: "b/y", providerID: "b", id: "y" }),
  ])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "free")
  state.cooldowns["a/x"] = PERMANENT_COOLDOWN_MS     // spent promotional quota
  state.cooldowns["b/y"] = DEPRECATED_COOLDOWN_MS    // deprecated model
  await engine.setMode("cheap", "ses_loop")
  assert.equal(state.loops["ses_loop"].mode, "cheap")
  assert.ok(state.cooldowns["a/x"] === undefined)
  assert.equal(state.cooldowns["b/y"], DEPRECATED_COOLDOWN_MS)
})

test("a mode degrades only when two different providers are both out of money", async () => {
  const { engine, state } = makeEngine("i1")
  const cat = catalogueOf([
    row({ key: "alibaba/qwen3.7-flash", providerID: "alibaba", id: "qwen3.7-flash" }),
    row({ key: "opencode/deepseek-v4-flash", providerID: "opencode", id: "deepseek-v4-flash" }),
  ])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "cheap")
  const tracked = engine.trackedSessions().find((s) => s.sessionID === "ses_loop")!

  // One provider out: rotate, but the loop's mode stays put.
  tracked.model = { providerID: "alibaba", id: "qwen3.7-flash" }
  await engine.onError({ sessionID: "ses_loop", message: "insufficient funds" })
  assert.equal(state.loops["ses_loop"].mode, "cheap")
  assert.equal(state.loops["ses_loop"].degraded, false)

  // The second provider runs out: cheap -> free on THIS loop, and it stays.
  tracked.model = { providerID: "opencode", id: "deepseek-v4-flash" }
  await engine.onError({ sessionID: "ses_loop", message: "insufficient funds" })
  assert.equal(state.loops["ses_loop"].mode, "free")
  assert.equal(state.loops["ses_loop"].degraded, true)

  // A stale mark from a resettled account no longer counts: alibaba's mark
  // aged out, so one provider being out is a rotation, not a mode change.
  state.fundsProviders.alibaba = Date.now() - 25 * 60 * 60 * 1000
  await engine.setMode("cheap", "ses_loop")
  tracked.model = { providerID: "opencode", id: "deepseek-v4-flash" }
  await engine.onError({ sessionID: "ses_loop", message: "insufficient funds" })
  assert.equal(state.loops["ses_loop"].mode, "cheap")
})

test("a retry scheduled on a free-mode loop cuts the storm: cooldown, rotate, redrive", async () => {
  const { engine, state, fakes } = makeEngine("i1")
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x", pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ key: "b/y", providerID: "b", id: "y", pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "free")
  const tracked = engine.trackedSessions().find((s) => s.sessionID === "ses_loop")!
  tracked.model = { providerID: "a", id: "x" }

  await engine.onRetryScheduled("ses_loop", { message: "upstream request failed", type: "provider.error" })

  // The failing model is on the free sweep's one-day cooldown, the turn was
  // interrupted, and the chain rotated to the next untried model.
  assert.ok(state.cooldowns["a/x"] !== undefined)
  assert.ok(state.cooldowns["a/x"]! > Date.now() + 23 * 60 * 60 * 1000)
  assert.deepEqual(fakes.interrupted, ["ses_loop"])
  assert.equal(state.loops["ses_loop"].lastResult, "rotated general to b/y (retry-after-network)")
  // The re-drive owns the next prompt, exactly like a hang interrupt.
  assert.ok((engine as unknown as { redrives: Map<string, number> }).redrives.has("ses_loop"))
})

test("paid-mode loops let opencode's own retries finish", async () => {
  const { engine, state, fakes } = makeEngine("i1")
  const cat = catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "cheap")
  const tracked = engine.trackedSessions().find((s) => s.sessionID === "ses_loop")!
  tracked.model = { providerID: "a", id: "x" }

  await engine.onRetryScheduled("ses_loop", { message: "upstream request failed" })

  assert.equal(fakes.interrupted.length, 0)
  assert.ok(state.cooldowns["a/x"] === undefined)
})

test("a second retry within the cut window is the same storm, not a new failure", async () => {
  const { engine, state, fakes } = makeEngine("i1")
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x", pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ key: "b/y", providerID: "b", id: "y", pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "free")
  const tracked = engine.trackedSessions().find((s) => s.sessionID === "ses_loop")!
  tracked.model = { providerID: "a", id: "x" }

  await engine.onRetryScheduled("ses_loop", { message: "upstream request failed" })
  const interrupted = fakes.interrupted.length
  const rotated = state.loops["ses_loop"].rotations
  // The same turn's second retry event arrives milliseconds later: ignored.
  await engine.onRetryScheduled("ses_loop", { message: "upstream request failed" })
  assert.equal(fakes.interrupted.length, interrupted)
  assert.equal(state.loops["ses_loop"].rotations, rotated)
})

test("a retry on a session we do not own is ignored", async () => {
  const { engine, state, fakes } = makeEngine("i1")
  armLoop(engine, state, "i1", "ses_loop", "free")
  await engine.onRetryScheduled("ses_user", { message: "upstream request failed" })
  assert.equal(fakes.interrupted.length, 0)
})

test("applying an already-seen intent reports no change", async () => {
  const { engine, state } = makeEngine("i1")
  state.intent = { seq: 7, action: "none", at: Date.now() }
  // The engine's applied marker mirrors the state it was built with (all
  // builds read state first), so advance it to the seeded seq.
  ;(engine as unknown as { appliedIntent: number }).appliedIntent = 7
  const applied = await engine.applyIntent({ ...state, intent: { seq: 7, action: "none", at: Date.now() } })
  assert.equal(applied, false)
  const fresh = await engine.applyIntent({ ...state, intent: { seq: 8, action: "halt", at: Date.now() } })
  assert.equal(fresh, true)
  assert.equal(Object.keys(state.loops).length, 0) // no loops to halt
})

/* -------------------------------------------------------------------- catalogue */

function row(patch: Partial<CatalogueModel>): CatalogueModel {
  const model = {
    key: "x/y",
    providerID: "x",
    id: "y",
    name: "y",
    description: "",
    family: "",
    releaseDate: "2026-01-01",
    knowledge: "",
    openWeights: false,
    context: 200_000,
    maxOutput: 8_192,
    capabilities: {
      text: true,
      image: false,
      audio: false,
      pdf: false,
      video: false,
      reasoning: true,
      toolCall: true,
      structured: true,
      embedding: false,
    },
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    local: false,
    canonicalID: null,
    benchmarks: null,
    scores: { reasoning: 6, code: 6, agentic: 6, general: 6, capability: 6 },
    provenance: {
      metadata: "models.dev",
      benchmark: null,
      estimated: false,
      estimatedFields: [],
    },
    weights: { total: null, active: null, moe: false, source: "unknown" },
    cloud: true,
    freeTier: null,
    reachable: true,
    available: true,
    availabilityReason: null,
    cooldownUntil: 0,
  }
  return Object.assign(model, patch) as CatalogueModel
}

function catalogueOf(models: CatalogueModel[]): Catalogue {
  const byKey = new Map(models.map((m) => [m.key, m]))
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sources: [],
    models,
    byKey,
    byProvider: new Map(),
    byCanonical: new Map(),
  }
}

test("unroutable and cooling models never satisfy a query", () => {
  const reachable = row({ key: "a/x", providerID: "a", id: "x" })
  const unroutable = row({ key: "b/x", providerID: "b", id: "x", reachable: false })
  const cooled = row({ key: "c/x", providerID: "c", id: "x", cooldownUntil: Date.now() + 60_000 })
  assert.equal(meets(reachable, { text: true }), true)
  assert.equal(meets(unroutable, { text: true }), false)
  assert.equal(meets(cooled, { text: true }), false)
})

test("the curated free tier table is the one the catalogue loads from", () => {
  // The 2026-10-12 console snapshot: every row switched on, and the models
  // whose promotional quota is spent (qwen3.7-flash among them) are absent —
  // they are paid rows now, not free-tier rows.
  assert.ok(FREE_TIERS["alibaba/qwen3.8-flash"]?.tokens === 1_000_000)
  assert.equal(FREE_TIERS["alibaba/qwen3.8-flash"]?.enabled, true)
  assert.equal(FREE_TIERS["alibaba/deepseek-v4-flash-0731"]?.enabled, true)
  assert.ok(FREE_TIERS["alibaba/qwen3.7-flash"] === undefined)
  // Every entry names its source and the account state, so a number can be
  // audited rather than trusted, and the blanket promotion is uniform.
  for (const [key, tier] of Object.entries(FREE_TIERS)) {
    assert.ok(key.startsWith("alibaba/"), key)
    assert.ok(tier.source.length > 0, key)
    assert.ok(tier.windowDays > 0, key)
    assert.equal(tier.tokens, 1_000_000, key)
    assert.equal(typeof tier.enabled, "boolean", key)
  }
})

/* ---------------------------------------------------------------------- modes */

test("free ranking walks free, then quota, then local", () => {
  const cat = catalogueOf([
    row({ key: "free/a", id: "a", scores: { reasoning: 7, code: 7, agentic: 7, general: 7, capability: 7 } }),
    row({ key: "quota/b", id: "b", pricing: { input: 0.03, output: 0.13, cacheRead: 0, cacheWrite: 0 }, freeTier: { tokens: 1_000_000, windowDays: 90, enabled: false, source: "t" }, scores: { reasoning: 7, code: 7, agentic: 7, general: 7, capability: 7.5 } }),
    row({ key: "local/c", id: "c", local: true, scores: { reasoning: 6, code: 6, agentic: 6, general: 6, capability: 6.2 } }),
  ])
  const ranked = rankForMode(cat, "free", profileFor("general"))
  assert.deepEqual(ranked.map((m) => m.id), ["a", "b", "c"])
})

test("an enabled quota outranks a switched-off one of equal capability", () => {
  const cat = catalogueOf([
    row({ key: "quota/off", id: "off", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, freeTier: { tokens: 1_000_000, windowDays: 91, enabled: false, source: "t" }, scores: { reasoning: 9, code: 9, agentic: 9, general: 9, capability: 9 } }),
    row({ key: "quota/on", id: "on", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, freeTier: { tokens: 1_000_000, windowDays: 91, enabled: true, source: "t" }, scores: { reasoning: 7, code: 7, agentic: 7, general: 7, capability: 7 } }),
  ])
  const ranked = rankForMode(cat, "free", profileFor("general"))
  assert.deepEqual(ranked.map((m) => m.id), ["on", "off"])
})

test("cheap ranking leads with the cheapest capable model, free tail after", () => {
  const cat = catalogueOf([
    row({ key: "cheap/a", id: "a", pricing: { input: 0.03, output: 0.13, cacheRead: 0, cacheWrite: 0 }, scores: { reasoning: 6, code: 7.5, agentic: 7, general: 7, capability: 6 } }),
    row({ key: "cheap/b", id: "b", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, scores: { reasoning: 7, code: 7.5, agentic: 7, general: 7, capability: 7 } }),
    row({ key: "free/c", id: "c", scores: { reasoning: 8, code: 8, agentic: 8, general: 8, capability: 8 } }),
  ])
  const ranked = rankForMode(cat, "cheap", profileFor("build"))
  assert.equal(ranked[0].id, "a")
  assert.equal(ranked[ranked.length - 1].id, "c")
})

/* -------------------------------------------------------------------- handoff */

test("context usage is read from v2 message tokens", () => {
  const used = measureContext({ data: [
    { type: "user", text: "hello" },
    { type: "assistant", content: [], tokens: { input: 30_000, output: 900, cache: { read: 5_000, write: 0 } } },
  ]})
  assert.equal(used, 35_000)
})

test("transcripts read v2 content parts and files from tool state", () => {
  const { turns, files } = transcriptFrom({ data: [
    { type: "user", text: "fix the parser" },
    { type: "assistant", content: [
      { type: "text", text: "checking now" },
      { type: "reasoning", text: "private thought" },
      { type: "tool", id: "call_1", state: { status: "success", input: { filePath: "src/parser.ts" } } },
    ]},
  ]})
  assert.deepEqual(turns, [{ role: "user", text: "fix the parser" }, { role: "assistant", text: "checking now" }])
  assert.deepEqual(files, ["src/parser.ts"])
})

test("descendant walks reach grandchildren", () => {
  const ids = descendantIDs([
    { id: "root", parentID: null },
    { id: "child", parentID: "root" },
    { id: "grand", parentID: "child" },
    { id: "other", parentID: null },
  ], "root")
  assert.deepEqual([...ids].sort(), ["child", "grand"])
})

test("the summary is deterministic and bounded", () => {
  const text = buildSummary({
    sessionID: "ses_x",
    task: "ship it",
    iterations: 3,
    reason: "test",
    transcript: [{ role: "user", text: "one" }, { role: "assistant", text: "two" }],
    files: ["a.ts"],
  })
  assert.match(text, /ship it/)
  assert.match(text, /a\.ts/)
  assert.ok(!text.includes("private"))
})

/* ----------------------------------------------------------- alibaba shaping */

const ALIBABA_FIXTURE = {
  output: {
    total: 3,
    models: [
      {
        model: "qwen3.7-flash",
        name: "Qwen3.7 Flash",
        description: "a cheap vision-language flash model",
        provider: "qwen",
        published_time: "2026-07-15 10:00:00",
        features: ["cache", "function-calling", "model-experience", "structured-outputs"],
        capabilities: ["Reasoning", "VU", "TG"],
        inference_metadata: { request_modality: ["Image", "Text", "Video"], response_modality: ["Text"] },
        model_info: { context_window: 1_000_000, max_output_tokens: 131_072 },
        prices: [{ prices: [
          { type: "input_token", price: "0.03", time_band: "standard" },
          { type: "output_token", price: "0.13", time_band: "standard" },
          { type: "input_token_cache_creation_5m", price: "0.038", time_band: "standard" },
          { type: "input_token_cache_read", price: "0.003", time_band: "standard" },
        ]}],
      },
      { model: "qwen3-asr-flash", name: "ASR", features: [], capabilities: [], model_info: {}, prices: [{ prices: [{ type: "asr_input_token", price: "0.035" }] }] },
      { model: "wan2.2-t2v-plus", name: "Video", features: [], capabilities: [], model_info: {}, prices: [{ prices: [{ type: "video_ratio", price: "1" }] }] },
    ],
  },
}

test("the inventory parser accepts the Model Studio and OpenAI shapes", () => {
  const rich = parseAlibabaInventory(ALIBABA_FIXTURE)
  assert.equal(rich.length, 3)
  assert.equal(rich[0].model, "qwen3.7-flash")
  const openai = parseAlibabaInventory({ data: [{ id: "glm-5.3", object: "model" }, { id: "kimi-k3", object: "model" }] })
  assert.deepEqual(openai.map((m) => m.model), ["glm-5.3", "kimi-k3"])
})

test("non-chat rows (ASR, video) are dropped, chat rows carry prices and modalities", () => {
  const rows = rowsFromAlibaba(parseAlibabaInventory(ALIBABA_FIXTURE))
  assert.equal(rows.length, 1)
  const [m] = rows
  assert.equal(m.providerID, "alibaba")
  assert.equal(m.id, "qwen3.7-flash")
  assert.equal(m.context, 1_000_000)
  assert.equal(m.pricing.input, 0.03)
  assert.equal(m.pricing.output, 0.13)
  assert.equal(m.pricing.cacheRead, 0.003)
  assert.equal(m.pricing.cacheWrite, 0.038)
  assert.equal(m.capabilities.text, true)
  assert.equal(m.capabilities.image, true)
  assert.equal(m.capabilities.video, true)
  assert.equal(m.capabilities.toolCall, true)
  assert.equal(m.capabilities.reasoning, true)
  assert.equal(m.source, "alibaba")
})

test("credential resolution prefers an override, then env, then the config", () => {
  assert.equal(resolveAlibabaKey("explicit", "/nonexistent"), "explicit")
  process.env.ALIBABA_API_KEY = "from-env"
  assert.equal(resolveAlibabaKey(undefined, "/nonexistent"), "from-env")
  delete process.env.ALIBABA_API_KEY
  // With no env, the resolver looks at the configured provider block and
  // returns null when nothing declares a key. The live account config is the
  // real source, so this only asserts it does not throw.
  const resolved = resolveAlibabaKey(undefined, process.env.HOME ?? "")
  assert.ok(resolved === null || typeof resolved === "string")
})

test("the catalogue is refresh-due only after its window, and missing files are due", () => {
  const dir = mkdtempSync(join(tmpdir(), "dont-stop-cat-"))
  const file = join(dir, "catalogue.json")
  assert.equal(catalogueRefreshDue(file), true)              // absent => due
  writeFileSync(file, "{}")
  assert.equal(catalogueRefreshDue(file), false)             // fresh => not due
  const now = Date.now()
  const old = now - 25 * 60 * 60 * 1000
  utimesSync(file, new Date(old), new Date(old))
  assert.equal(catalogueRefreshDue(file), true)              // stale => due
  assert.equal(catalogueRefreshDue(file, now, 48 * 60 * 60 * 1000), false)  // a wider window defers it
})

/* --------------------------------------------------------------------- engine */

/** A fake plugin context that records what the engine tries to do. */
function fakeContext() {
  const switched: Array<{ sessionID: string; model: unknown }> = []
  const interrupted: string[] = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const sessions: Record<string, { id: string; parentID: string | null }> = {}
  const context = {
    agent: { transform: async () => {}, reload: async () => {}, list: async () => ({ data: [] }) },
    session: {
      switchModel: async (input: { sessionID: string; model: unknown }) => {
        switched.push(input)
      },
      interrupt: async (input: { sessionID: string }) => {
        interrupted.push(input.sessionID)
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push(input)
      },
      create: async () => ({ id: "ses_new" }),
      list: async (input?: { parentID?: string | null }) => ({
        data: Object.values(sessions).filter((s) => (input?.parentID ?? null) === (s.parentID ?? null)),
      }),
      active: async () => ({ data: { ses_loop: {}, ses_child: {} } }),
      context: async () => ({ data: [] }),
    },
    model: { list: async () => ({ data: [{ providerID: "a", id: "x" }] }) },
  }
  return {
    context: context as unknown as ConstructorParameters<typeof LoopEngine>[0],
    switched, interrupted, prompts, sessions,
  }
}

function makeEngine(instanceID: string) {
  const fakes = fakeContext()
  const state: PluginState = initialState()
  const log = { info: () => {}, warn: () => {}, error: () => {}, quiet: () => {} }
  const engine = new LoopEngine(fakes.context, state, log, { instanceID })
  return { engine, state, fakes }
}

function armLoop(engine: LoopEngine, state: PluginState, instanceID: string, sessionID: string, mode: Mode = "free") {
  state.loops[sessionID] = {
    status: "active", sessionID, prompt: "task", iterations: 0,
    startedAt: Date.now(), lastResult: null, owner: instanceID,
    ownerBeatAt: Date.now(), rotations: 0,
    mode, degraded: false, preferredMode: null, consecutiveErrors: 0,
  }
  engine.track(sessionID, "general")
  // A live turn: the server's own execution-started event is what arms the
  // turn in a real run, so reproduce it here.
  engine.observe({ type: "session.execution.started", data: { sessionID } })
}

test("rotation walks the chain once and then stops instead of cycling", () => {
  const { engine, state } = makeEngine("i1")
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x", scores: { reasoning: 7, code: 7, agentic: 7, general: 7, capability: 7 } }),
    row({ key: "b/y", providerID: "b", id: "y", scores: { reasoning: 6, code: 6, agentic: 6, general: 6, capability: 6 } }),
    row({ key: "c/z", providerID: "c", id: "z", scores: { reasoning: 5, code: 5, agentic: 5, general: 5, capability: 5 } }),
  ])
  injectCatalogue(engine, cat)
  state.mode = "free"
  armLoop(engine, state, "i1", "ses_loop")

  assert.equal(engine.rotate("ses_loop", "rate"), "moved")
  assert.equal(engine.status!.lastResult, "rotated general to a/x (rate)")
  assert.equal(engine.rotate("ses_loop", "rate"), "moved")
  assert.equal(engine.rotate("ses_loop", "rate"), "exhausted")
  // A foreign session is not ours to move.
  assert.equal(engine.rotate("ses_someone_else", "rate"), "not-ours")
})

test("a turn-end pair advances once", async () => {
  const { engine, state } = makeEngine("i1")
  armLoop(engine, state, "i1", "ses_loop")

  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  const iterations = state.loops["ses_loop"].iterations
  assert.equal(iterations, 1)
  // The trailing idle/status ending that follows an execution result must
  // not advance again: the continue prompt is not a second turn's result.
  await engine.onTurnEnd("ses_loop", "session.idle")
  assert.equal(state.loops["ses_loop"].iterations, iterations)

  // A subagent ending its own turn does not advance the loop.
  await engine.onTurnEnd("ses_child", "session.execution.succeeded")
  assert.equal(state.loops["ses_loop"].iterations, iterations)
})

test("our own interrupt defers to the re-drive instead of advancing", async () => {
  const { engine, state } = makeEngine("i1")
  armLoop(engine, state, "i1", "ses_loop")

  // Simulate the hang path's interrupt (its own marker): the ending event must
  // stand down because the re-drive owns the next prompt.
  const priv = engine as unknown as { lastHangInterruptAt: number }
  priv.lastHangInterruptAt = Date.now()
  await engine.onTurnEnd("ses_loop", "session.execution.interrupted")
  assert.equal(state.loops["ses_loop"].iterations, 0)

  // A user escape well after the hang path's interrupt schedules the
  // re-drive instead of stopping: the loop waits its beat and continues.
  engine.observe({ type: "session.execution.started", data: { sessionID: "ses_loop" } })
  priv.lastHangInterruptAt = 0
  await engine.onTurnEnd("ses_loop", "session.execution.interrupted")
  assert.equal(state.loops["ses_loop"].iterations, 0)
  assert.ok((engine as unknown as { redriveAt: number | null }).redriveAt !== null)
})

test("the completion sentinel stops the loop", async () => {
  const { engine, state } = makeEngine("i1")
  armLoop(engine, state, "i1", "ses_loop")
  const withMessages = {
    ...fakeContext(),
    session: {
      ...fakeContext().context.session,
      context: async () => ({ data: [
        { type: "user", text: "task" },
        { type: "assistant", content: [{ type: "text", text: `done ${COMPLETION_SENTINEL}` }] },
      ]}),
    },
  }
  ;(engine as unknown as { ctx: unknown }).ctx = { session: withMessages.session }
  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.equal(state.loops["ses_loop"].status, "stopped")
  assert.match(state.loops["ses_loop"].lastResult ?? "", /task complete/)
})

test("halt interrupts the whole tree, drops clocks, and keeps the loop session tracked", async () => {
  const { engine, state, fakes } = makeEngine("i1")
  armLoop(engine, state, "i1", "ses_loop")
  engine.track("ses_child", "general")
  fakes.sessions.loop = { id: "ses_loop", parentID: null }
  fakes.sessions.child = { id: "ses_child", parentID: "ses_loop" }
  engine.observe({ type: "session.execution.started", data: { sessionID: "ses_loop" } })
  engine.observe({ type: "session.execution.started", data: { sessionID: "ses_child" } })

  await engine.stop("halted by test")

  assert.equal(state.loops["ses_loop"].status, "stopped")
  assert.deepEqual(fakes.interrupted.sort(), ["ses_child", "ses_loop"])
  // The loop session stays tracked so a later start can find it.
  assert.ok(engine.trackedSessions().some((s) => s.sessionID === "ses_loop"))
  // The child does not: it belonged to a loop that is over.
  assert.ok(!engine.trackedSessions().some((s) => s.sessionID === "ses_child"))
})

test("a foreign owner's loop is not driven", async () => {
  const { engine, state } = makeEngine("i2")
  armLoop(engine, state, "someone-else", "ses_loop")
  assert.equal(engine.ownsLoop("ses_loop"), false)
  assert.equal(engine.rotate("ses_loop", "test"), "not-ours")
  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.equal(state.loops["ses_loop"].iterations, 0)
})

test("two sessions run their own loops, each with its own mode", async () => {
  const { engine, state } = makeEngine("i1")
  injectCatalogue(engine, catalogueOf([
    row({ key: "a/free", providerID: "a", id: "free", pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ key: "b/paid", providerID: "b", id: "paid", pricing: { input: 0.03, output: 0.13, cacheRead: 0, cacheWrite: 0 } }),
  ]))
  armLoop(engine, state, "i1", "ses_a", "free")
  armLoop(engine, state, "i1", "ses_b", "cheap")

  // Each loop advances on its own session's turn endings.
  await engine.onTurnEnd("ses_a", "session.execution.succeeded")
  await engine.onTurnEnd("ses_b", "session.execution.succeeded")
  assert.equal(state.loops["ses_a"].iterations, 1)
  assert.equal(state.loops["ses_b"].iterations, 1)

  // A mode change on one session leaves the other's loop alone.
  assert.equal(state.loops["ses_a"].mode, "free")
  await engine.setMode("cheap", "ses_a")
  assert.equal(state.loops["ses_a"].mode, "cheap")
  assert.equal(state.loops["ses_b"].mode, "cheap")

  // Halting ONE loop leaves the other running.
  await engine.stop("halted by test", "ses_a")
  assert.equal(state.loops["ses_a"].status, "stopped")
  assert.equal(state.loops["ses_b"].status, "active")
})

test("a halt with no session stops every loop this instance drives", async () => {
  const { engine, state } = makeEngine("i1")
  armLoop(engine, state, "i1", "ses_a", "free")
  armLoop(engine, state, "i1", "ses_b", "free")
  await engine.stop("stopped by command")
  assert.equal(state.loops["ses_a"].status, "stopped")
  assert.equal(state.loops["ses_b"].status, "stopped")
})

test("consecutive errors from foreign sessions never stop the loop", async () => {
  const { engine, state } = makeEngine("i1")
  armLoop(engine, state, "i1", "ses_loop")
  engine.track("ses_user", "general")
  for (let i = 0; i < 6; i++) {
    await engine.onError({ sessionID: "ses_user", agent: "general", message: "boom", type: "provider.unknown" })
  }
  assert.equal(state.loops["ses_loop"].status, "active")
})

/* -------------------------------------------------------------------- helpers */

/** Put a catalogue on an engine without touching the disk. */
function injectCatalogue(engine: LoopEngine, cat: Catalogue): void {
  ;(engine as unknown as { catalogue: Catalogue | null }).catalogue = cat
}

test("the state file round-trips without a live server", () => {
  const state = readState()
  assert.ok(Array.isArray(state.log))
  assert.ok(typeof state.mode === "string")
})