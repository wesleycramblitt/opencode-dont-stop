#!/usr/bin/env -S npx tsx
/**
 * dont-stop unit tests.
 *
 * Pure modules first (events, clocks, errors, catalogue, rotation, the alibaba
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
import { clearCooldown, cooldown, meets, loadCatalogue, type Catalogue, type CatalogueModel, type HardwareProfile } from "../lib/catalogue.ts"
import { rankForMode, profileFor } from "../lib/modes.ts"
import { measureContext, descendantIDs, effectiveContext, ollamaServedContext, shouldRotate } from "../lib/rotation.ts"
import { catalogueRefreshDue, parseAlibabaInventory, rowsFromAlibaba, resolveAlibabaKey } from "../lib/fetch.ts"
import { LoopEngine, CONTINUE_PROMPT, type EngineOptions } from "../lib/engine.ts"
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

test("stale reasoning state is its own kind: compact, never cool or rotate", () => {
  // The observed shape: the provider refuses a reasoning item the transcript
  // references because the endpoint no longer holds it. Reading it as
  // `notfound` would cool a working model for 24h over a transcript problem.
  const item = classify({ message: "Item 'rs_abc123' of type 'reasoning' was not found or has expired." })
  assert.equal(item.kind, "state")
  const referenced = classify({ message: "referenced reasoning item 'rs_abc123' was not found or has expired" })
  assert.equal(referenced.kind, "state")

  for (const mode of ["free", "cheap"] as const) {
    const action = actionFor(item, mode)
    assert.equal(action.compact, true, "the transcript is replaced")
    assert.equal(action.cooldownMs, 0, "the model is not at fault")
    assert.equal(action.resweep, false, "no rotation to pay")
    assert.equal(action.retry, false)
  }
})

test("free-mode failures: one try, one hour out, spent quotas out forever", () => {
  const rate = actionFor(classify({ message: "rate limit reached" }), "free")
  assert.equal(rate.resweep, true)
  assert.equal(rate.retry, false)
  assert.equal(rate.cooldownMs, 60 * 60 * 1000)

  const network = actionFor(classify({ message: "fetch failed" }), "free")
  assert.equal(network.retry, false)
  assert.equal(network.cooldownMs, 60 * 60 * 1000)

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

  // The failing model is on the free sweep's one-hour cooldown, the turn was
  // interrupted, and the chain rotated to the next untried model.
  assert.ok(state.cooldowns["a/x"] !== undefined)
  assert.ok(state.cooldowns["a/x"]! > Date.now() + 59 * 60 * 1000)
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

test("a mode intent moves the default mode and the primary loop", async () => {
  const { engine, state } = makeEngine("i1")
  const cat = catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "free")

  const applied = await engine.applyIntent({
    ...state,
    intent: { seq: 9, action: "mode", mode: "cheap", at: Date.now() },
  })
  assert.equal(applied, true)
  assert.equal(state.mode, "cheap")
  assert.equal(state.loops["ses_loop"].mode, "cheap")
  // A stale intent (lower seq) is ignored.
  const replay = await engine.applyIntent({
    ...state,
    intent: { seq: 8, action: "mode", mode: "power", at: Date.now() },
  })
  assert.equal(replay, false)
  assert.equal(state.mode, "cheap")
})

test("setMode announces a mode intent so other instances follow", async () => {
  const { engine, state } = makeEngine("i1")
  const cat = catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "free")

  await engine.setMode("power")
  assert.equal(state.intent.action, "mode")
  assert.equal(state.intent.mode, "power")
  assert.equal(state.loops["ses_loop"].mode, "power")
})

test("a provider/model cooldown excludes the variant row too", () => {
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x" }),
    row({ key: "a/x#v1", providerID: "a", id: "x", variant: "v1" }),
  ])
  const until = Date.now() + 60_000
  cooldown(cat, "a/x", until)
  assert.equal(cat.byKey.get("a/x")!.cooldownUntil, until)
  assert.equal(cat.byKey.get("a/x#v1")!.cooldownUntil, until)
  clearCooldown(cat, "a/x")
  assert.equal(cat.byKey.get("a/x")!.cooldownUntil, 0)
  assert.equal(cat.byKey.get("a/x#v1")!.cooldownUntil, 0)
})

test("discover re-asserts persisted cooldowns on a fresh catalogue", async () => {
  const { engine, state } = makeEngine("i1")
  const until = Date.now() + 24 * 60 * 60 * 1000
  state.cooldowns = { "opencode/step-5-preview-free": until }
  await engine.discover()
  const row = engine.model!.byKey.get("opencode/step-5-preview-free")
  assert.ok(row, "the cooled model is in the catalogue")
  assert.equal(row!.cooldownUntil, until)
  // The cooling model is not selectable in the free chain after the reload.
  const ranked = rankForMode(engine.model!, "free", profileFor("general"))
  assert.ok(!ranked.some((m) => m.key === "opencode/step-5-preview-free"))
})

test("a restarted session is re-seeded with the full loop prompt", async () => {
  // reseedGraceMs: 0 exercises the detector directly; the default window
  // suppresses it for the first 90s after boot (its own test below).
  const { engine, state, fakes } = makeEngine("i1", { reseedGraceMs: 0 })
  const cat = catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "free")
  // The armed turn ends: the loop is idle, waiting to be driven again.
  engine.observe({ type: "session.execution.failed", data: { sessionID: "ses_loop" } })

  // Baseline: the session holds three messages. A restart clears them.
  fakes.messages.push({ id: 1 }, { id: 2 }, { id: 3 })
  const reseed = engine as unknown as { maybeReseedRestarted(sessionID: string): Promise<void> }
  await reseed.maybeReseedRestarted("ses_loop")
  assert.equal(fakes.prompts.length, 0, "no restart yet: count unchanged")

  fakes.messages.splice(0, fakes.messages.length)
  fakes.messages.push({ id: 1 })
  await reseed.maybeReseedRestarted("ses_loop")
  const text = fakes.prompts.at(-1)?.text ?? ""
  assert.equal(text, "task", "the mission is re-injected, with nothing appended")
  assert.equal(state.loops["ses_loop"].turnStartedAt !== null, true, "the reseed starts a turn")
  assert.equal(state.loops["ses_loop"].lastResult, "session restarted; loop prompt re-injected")
})

test("the restart detector stands down during the boot grace", async () => {
  const { engine, state, fakes } = makeEngine("i1") // default grace
  const cat = catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "free")
  engine.observe({ type: "session.execution.failed", data: { sessionID: "ses_loop" } })
  // Seed a count that clearly dropped: with the grace gone this would
  // re-seed, so the no-op proves the boot window is what suppressed it.
  ;(engine as unknown as { messageCounts: Map<string, number> }).messageCounts.set("ses_loop", 5)
  fakes.messages.push({ id: 1 })
  const reseed = engine as unknown as { maybeReseedRestarted(sessionID: string): Promise<void> }
  await reseed.maybeReseedRestarted("ses_loop")
  assert.equal(fakes.prompts.length, 0, "opencode's own resume owns the boot window")
})

test("a loop orphaned by a service restart is recovered, not halted", async () => {
  const { engine, state, fakes } = makeEngine("i2")
  const cat = catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "free")
  state.loops["ses_loop"].ownerBeatAt = Date.now() - 10 * 60 * 1000
  fakes.messages.push({ id: 1 }, { id: 2 })

  await engine.recoverOrphanedLoops(state)

  assert.equal(state.loops["ses_loop"].status, "active", "the loop survives the restart")
  assert.equal(state.loops["ses_loop"].owner, "i2", "the new instance adopts it")
  assert.equal(state.loops["ses_loop"].lastResult, "recovered after restart; continuing")
  assert.ok(
    (engine as unknown as { redrives: Map<string, number> }).redrives.has("ses_loop"),
    "a re-drive covers the case opencode does not resume",
  )
  assert.equal(fakes.interrupted.length, 0)
})

test("a loop whose session cannot be read is still halted on boot", async () => {
  const { engine, state, fakes } = makeEngine("i2")
  armLoop(engine, state, "i1", "ses_loop", "free")
  state.loops["ses_loop"].ownerBeatAt = Date.now() - 10 * 60 * 1000
  ;(fakes.context as unknown as { session: { context: () => Promise<unknown> } }).session.context = async () => {
    throw new Error("session gone")
  }

  await engine.recoverOrphanedLoops(state)

  assert.equal(state.loops["ses_loop"].status, "stopped")
  assert.equal(state.loops["ses_loop"].lastResult, "loop orphaned: the instance running it is gone")
})

test("a stale reasoning-state failure compacts the transcript and re-drives", async () => {
  const { engine, state, fakes } = makeEngine("i1")
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x" }),
    row({ key: "b/y", providerID: "b", id: "y" }),
  ])
  injectCatalogue(engine, cat)
  armLoop(engine, state, "i1", "ses_loop", "free")
  const tracked = engine.trackedSessions().find((s) => s.sessionID === "ses_loop")!
  tracked.model = { providerID: "a", id: "x" }

  await engine.onError({
    sessionID: "ses_loop",
    message: "referenced reasoning item 'rs_abc123' was not found or has expired",
  })

  assert.deepEqual(fakes.compacted, ["ses_loop"], "the transcript carrying the dangling reference is replaced")
  assert.ok(state.cooldowns["a/x"] === undefined, "the model is not cooled down")
  assert.ok(
    (engine as unknown as { redrives: Map<string, number> }).redrives.has("ses_loop"),
    "the continue prompt is re-driven against the compacted context",
  )
})

test("the loop nudges each turn and restates the mission on a cadence", async () => {
  const { engine, state, fakes } = makeEngine("i1", { sessionSteps: 100, reinjectEvery: 2 })
  injectCatalogue(engine, catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })]))
  armLoop(engine, state, "i1", "ses_loop", "free")

  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.equal(fakes.prompts.at(-1)?.text, CONTINUE_PROMPT, "a plain turn gets the short nudge")

  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  const prompt = fakes.prompts.at(-1)?.text ?? ""
  assert.match(prompt, /^task/, "the mission is restated on the cadence")
  assert.match(prompt, /Keep working\.$/)
})

test("a step-budget compaction re-anchors the full loop prompt", async () => {
  const { engine, state, fakes } = makeEngine("i1", { sessionSteps: 1, reinjectEvery: 100 })
  injectCatalogue(engine, catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })]))
  armLoop(engine, state, "i1", "ses_loop", "free")

  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")

  assert.deepEqual(fakes.compacted, ["ses_loop"], "the step budget compacts the transcript")
  const prompt = fakes.prompts.at(-1)?.text ?? ""
  assert.match(prompt, /^task/, "the mission is re-injected after the compaction")
  assert.match(prompt, /Keep working\.$/)
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

test("the architect's free-mode chain leads with its preferred models", () => {
  const cat = catalogueOf([
    row({ key: "oller/zeta", providerID: "oller", id: "zeta", local: false, context: 262144 }),
    row({ key: "ollama/qwen3.5:9b", providerID: "ollama", id: "qwen3.5:9b", local: true, context: 262144 }),
    row({ key: "ollama/qwen3.5:9b-ctx256k", providerID: "ollama", id: "qwen3.5:9b-ctx256k", local: true, context: 262144 }),
    row({ key: "ollama/qwen3-coder:30b-ctx256k", providerID: "ollama", id: "qwen3-coder:30b-ctx256k", local: true, context: 262144 }),
    row({ key: "ollama/qwen3-coder:30b", providerID: "ollama", id: "qwen3-coder:30b", local: true, context: 262144 }),
  ])
  const architect = rankForMode(cat, "free", profileFor("architect"))
  assert.equal(architect[0].key, "ollama/qwen3.5:9b-ctx256k", "the architect leads with the small big-window coder")
  assert.equal(architect[1].key, "ollama/qwen3-coder:30b-ctx256k", "the 30B variant follows as the capable fallback")
  assert.ok(architect.some((m) => m.key === "ollama/qwen3-coder:30b"), "the plain tag stays in the chain as fallback")
  const general = rankForMode(cat, "free", profileFor("general"))
  assert.equal(general[0].key, "oller/zeta", "smaller tasks keep the remote-first sweep")
  const power = rankForMode(cat, "power", profileFor("architect"))
  assert.equal(power[0].key, "oller/zeta", "the lead does not leak into power mode")
})

test("an agent lead that cannot load on this card is skipped", () => {
  const cat = catalogueOf([
    row({ key: "oller/zeta", providerID: "oller", id: "zeta", local: false, context: 262144 }),
    row({
      key: "ollama/qwen3.5:9b-ctx256k", providerID: "ollama", id: "qwen3.5:9b-ctx256k", local: true,
      context: 262144, weights: { total: 9, active: 9, moe: false, source: "tag" },
    }),
    row({
      key: "ollama/qwen3-coder:30b-ctx256k", providerID: "ollama", id: "qwen3-coder:30b-ctx256k", local: true,
      context: 262144, weights: { total: 30, active: 30, moe: false, source: "tag" },
    }),
  ])
  const laptop: HardwareProfile = { name: "8gb", vramGB: 8, quant: "q4" }
  const architect = rankForMode(cat, "free", profileFor("architect"), laptop)
  assert.equal(architect[0].key, "oller/zeta", "leads that cannot load on 8GB fall through to the ranking")
  const desktop = rankForMode(cat, "free", profileFor("architect"))
  assert.equal(desktop[0].key, "ollama/qwen3.5:9b-ctx256k", "the same list leads on the 24GB desktop")
})

test("the hardware profile reaches the engine's plan", () => {
  const { engine, state } = makeEngine("i1", { hardware: { name: "8gb", vramGB: 8, quant: "q4" } })
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x", local: true, cloud: false, weights: { total: 30, active: 30, moe: false, source: "tag" } }),
    row({ key: "b/y", providerID: "b", id: "y", local: true, cloud: false, weights: { total: 3, active: 3, moe: false, source: "tag" } }),
  ])
  injectCatalogue(engine, cat)
  const plan = engine.buildPlan("local")
  assert.equal(plan.agents["general"]?.id, "y", "the plan picks the model that fits the machine")
})

test("unroutable and cooling models never satisfy a query", () => {
  const reachable = row({ key: "a/x", providerID: "a", id: "x" })
  const unroutable = row({ key: "b/x", providerID: "b", id: "x", reachable: false })
  const cooled = row({ key: "c/x", providerID: "c", id: "x", cooldownUntil: Date.now() + 60_000 })
  assert.equal(meets(reachable, { text: true }), true)
  assert.equal(meets(unroutable, { text: true }), false)
  assert.equal(meets(cooled, { text: true }), false)
})

test("the free-tier table is empty: every 2026-10-12 grant was consumed", () => {
  // The overnight loop drew the promotional grants down model after model
  // and the provider refused each one with "free quota has been exhausted".
  // The contract (data/free-tiers.ts): spent models are ABSENT, so the sweep
  // can never offer them again — and absence must beat the stale copy in a
  // catalogue file (the load applies this table outright).
  assert.equal(Object.keys(FREE_TIERS).length, 0)
})

test("a spent free quota is stored as the sentinel itself, and a mode change lifts it", async () => {
  const { engine, state } = makeEngine("i1")
  injectCatalogue(engine, catalogueOf([
    row({ key: "alibaba/x", providerID: "alibaba", id: "x" }),
    row({ key: "b/y", providerID: "b", id: "y" }),
  ]))
  armLoop(engine, state, "i1", "ses_loop", "free")
  const tracked = engine.trackedSessions().find((s) => s.sessionID === "ses_loop")!
  tracked.model = { providerID: "alibaba", id: "x" }

  // `now + sentinel` would be larger than the sentinel it was made from, so
  // the exclusion could never be matched again — store the sentinel itself.
  await engine.onError({ sessionID: "ses_loop", message: "The free quota has been exhausted" })
  assert.equal(state.cooldowns["alibaba/x"], PERMANENT_COOLDOWN_MS)

  // Leaving free mode lifts the quota exclusion: the model is a paid row now.
  await engine.setMode("cheap", "ses_loop")
  assert.ok(state.cooldowns["alibaba/x"] === undefined)
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

/* ------------------------------------------------------------------ rotation */

test("context usage is read from v2 message tokens", () => {
  const used = measureContext({ data: [
    { type: "user", text: "hello" },
    { type: "assistant", content: [], tokens: { input: 30_000, output: 900, cache: { read: 5_000, write: 0 } } },
  ]})
  assert.equal(used, 35_000)
})

test("a local model's window is what the daemon serves, not the native size", () => {
  // ollama's OLLAMA_CONTEXT_LENGTH=64000 against a 3.5M native claim: the
  // session truncates at 64k, so that is the limit rotation must use.
  assert.equal(effectiveContext(3_500_000, 64_000), 64_000)
  assert.equal(effectiveContext(3_500_000, 0), 3_500_000)
  assert.equal(effectiveContext(0, 64_000), 64_000)
  assert.equal(effectiveContext(0, 0), 0)
})

test("the ollama probe reads the served context and tolerates junk", async () => {
  const respond = (body: unknown) =>
    (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch
  assert.equal(
    await ollamaServedContext("qwen3.8:latest", respond({ models: [{ name: "qwen3.8:latest", context_length: 64_000 }] })),
    64_000,
  )
  // Not loaded, or another model loaded: unknown, not a wrong number.
  assert.equal(await ollamaServedContext("qwen3.8:latest", respond({ models: [{ name: "other", context_length: 64_000 }] })), 0)
  assert.equal(await ollamaServedContext("qwen3.8:latest", respond({ models: "nope" })), 0)
  const down = (async () => {
    throw new Error("ollama is down")
  }) as unknown as typeof fetch
  assert.equal(await ollamaServedContext("qwen3.8:latest", down), 0)
})

test("context pressure is a threshold on the effective window", () => {
  assert.equal(shouldRotate(80_000, 100_000), true)
  assert.equal(shouldRotate(79_000, 100_000), false)
  // An unknown window is not pressure.
  assert.equal(shouldRotate(50, 0), false)
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
  const created: Array<{ title?: string; agent?: string }> = []
  const removed: string[] = []
  const sessions: Record<string, { id: string; parentID: string | null }> = {}
  const messages: unknown[] = []
  const compacted: string[] = []
  const context = {
    agent: { transform: async () => {}, reload: async () => {}, list: async () => ({ data: [] }) },
    session: {
      switchModel: async (input: { sessionID: string; model: unknown }) => {
        switched.push(input)
      },
      interrupt: async (input: { sessionID: string }) => {
        interrupted.push(input.sessionID)
      },
      compact: async (input: { sessionID: string }) => {
        compacted.push(input.sessionID)
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push(input)
      },
      create: async (input: { title?: string; agent?: string }) => {
        created.push(input)
        return { id: "ses_new" }
      },
      remove: async (input: { sessionID: string }) => {
        removed.push(input.sessionID)
      },
      list: async (input?: { parentID?: string | null }) => ({
        data: Object.values(sessions).filter((s) => (input?.parentID ?? null) === (s.parentID ?? null)),
      }),
      active: async () => ({ data: { ses_loop: {}, ses_child: {} } }),
      context: async () => ({ data: messages }),
    },
    model: { list: async () => ({ data: [{ providerID: "a", id: "x" }] }) },
  }
  return {
    context: context as unknown as ConstructorParameters<typeof LoopEngine>[0],
    switched, interrupted, prompts, created, removed, sessions, messages, compacted,
  }
}

function makeEngine(instanceID: string, options: Partial<EngineOptions> = {}) {
  const fakes = fakeContext()
  const state: PluginState = initialState()
  const log = { info: () => {}, warn: () => {}, error: () => {}, quiet: () => {} }
  const engine = new LoopEngine(fakes.context, state, log, { instanceID, ...options })
  return { engine, state, fakes }
}

function armLoop(engine: LoopEngine, state: PluginState, instanceID: string, sessionID: string, mode: Mode = "free") {
  state.loops[sessionID] = {
    status: "active", sessionID, sessionNumber: 1, prompt: "task", iterations: 0, sessionIterations: 0,
    startedAt: Date.now(), lastResult: null, owner: instanceID,
    ownerBeatAt: Date.now(), rotations: 0,
    mode, degraded: false, preferredMode: null, consecutiveErrors: 0,
    turnStartedAt: null,
  }
  engine.track(sessionID, "general")
  // A live turn: the server's own execution-started event is what arms the
  // turn in a real run, so reproduce it here.
  engine.observe({ type: "session.execution.started", data: { sessionID } })
}

test("rotation prefers a model that can hold the session's context", async () => {
  const { engine, state, fakes } = makeEngine("i1")
  // a/x ranks higher but its window (32k) cannot hold the 50k session;
  // b/y is the larger-window candidate.
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x", context: 40_000, scores: { reasoning: 9, code: 9, agentic: 9, general: 9, capability: 9 } }),
    row({ key: "b/y", providerID: "b", id: "y", context: 200_000, scores: { reasoning: 8, code: 8, agentic: 8, general: 8, capability: 8 } }),
  ])
  injectCatalogue(engine, cat)
  state.mode = "free"
  armLoop(engine, state, "i1", "ses_loop")
  fakes.messages.push({ type: "assistant", tokens: { input: 50_000 } })

  const outcome = await engine.rotate("ses_loop", "rate")
  assert.equal(outcome, "moved")
  assert.match(engine.status!.lastResult!, /rotated general to b\/y/)
})

test("an unloaded local model assumes the daemon cap, so a large session compacts before landing on the local tail", async () => {
  const { engine, state, fakes } = makeEngine("i1")
  // ollama/q has a huge native window (3.5M) but is not loaded, so the served
  // window is the unknown-cap guard (64k) — a 100k session must not switch
  // to it without compacting.
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x", context: 40_000, scores: { reasoning: 8, code: 8, agentic: 8, general: 8, capability: 8 } }),
    row({ key: "ollama/q", providerID: "ollama", id: "q", local: true, context: 3_500_000, scores: { reasoning: 9, code: 9, agentic: 9, general: 9, capability: 9 } }),
  ])
  injectCatalogue(engine, cat)
  state.mode = "free"
  armLoop(engine, state, "i1", "ses_loop")
  fakes.messages.push({ type: "assistant", tokens: { input: 100_000 } })

  const outcome = await engine.rotate("ses_loop", "rate")
  assert.equal(outcome, "moved")
  assert.deepEqual(fakes.compacted, ["ses_loop"], "the session is compacted before any local switch")
})

test("rotation compacts the session first when no candidate fits the context", async () => {
  const { engine, state, fakes } = makeEngine("i1")
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x", context: 40_000, scores: { reasoning: 7, code: 7, agentic: 7, general: 7, capability: 7 } }),
    row({ key: "b/y", providerID: "b", id: "y", context: 48_000, scores: { reasoning: 6, code: 6, agentic: 6, general: 6, capability: 6 } }),
  ])
  injectCatalogue(engine, cat)
  state.mode = "free"
  armLoop(engine, state, "i1", "ses_loop")
  fakes.messages.push({ type: "assistant", tokens: { input: 50_000 } })

  const outcome = await engine.rotate("ses_loop", "rate")
  assert.equal(outcome, "moved")
  assert.deepEqual(fakes.compacted, ["ses_loop"], "the session is compacted before the switch")
  assert.match(engine.status!.lastResult!, /rotated general to a\/x/)
})

test("refresh does not switch the loop session onto a window too small for it", async () => {
  const { engine, state, fakes } = makeEngine("i1")
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x", context: 40_000, scores: { reasoning: 9, code: 9, agentic: 9, general: 9, capability: 9 } }),
    row({ key: "b/y", providerID: "b", id: "y", context: 200_000 }),
  ])
  injectCatalogue(engine, cat)
  state.mode = "free"
  armLoop(engine, state, "i1", "ses_loop")
  // The session is on the big-window model and holds 50k tokens.
  engine.observe({
    type: "session.execution.started",
    data: { sessionID: "ses_loop", model: { providerID: "b", id: "y" } },
  })
  fakes.messages.push({ type: "assistant", tokens: { input: 50_000 } })

  // The plan prefers a/x (higher capability) but its 30k window cannot hold
  // the conversation; the switch is vetoed and the session stays on b/y.
  await engine.refresh(false)
  assert.deepEqual(fakes.switched, [], "no switch to a model too small for the session")
})

test("rotation walks the chain once and then stops instead of cycling", async () => {
  const { engine, state } = makeEngine("i1")
  const cat = catalogueOf([
    row({ key: "a/x", providerID: "a", id: "x", scores: { reasoning: 7, code: 7, agentic: 7, general: 7, capability: 7 } }),
    row({ key: "b/y", providerID: "b", id: "y", scores: { reasoning: 6, code: 6, agentic: 6, general: 6, capability: 6 } }),
    row({ key: "c/z", providerID: "c", id: "z", scores: { reasoning: 5, code: 5, agentic: 5, general: 5, capability: 5 } }),
  ])
  injectCatalogue(engine, cat)
  state.mode = "free"
  armLoop(engine, state, "i1", "ses_loop")

  assert.equal(await engine.rotate("ses_loop", "rate"), "moved")
  assert.equal(engine.status!.lastResult, "rotated general to a/x (rate)")
  assert.equal(await engine.rotate("ses_loop", "rate"), "moved")
  assert.equal(await engine.rotate("ses_loop", "rate"), "exhausted")
  // A foreign session is not ours to move.
  assert.equal(await engine.rotate("ses_someone_else", "rate"), "not-ours")
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

test("only a halt ends the loop", async () => {
  const { engine, state } = makeEngine("i1")
  armLoop(engine, state, "i1", "ses_loop")

  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.equal(state.loops["ses_loop"].status, "active")

  await engine.stop("halted by the owner", "ses_loop")
  assert.equal(state.loops["ses_loop"].status, "stopped")
  assert.match(state.loops["ses_loop"].lastResult ?? "", /halted by the owner/)
})

/* --------------------------------------------------------------- rotation */

test("a session rotates at the turn budget, carrying the loop", async () => {
  const { engine, state, fakes } = makeEngine("i1", { sessionSteps: 3 })
  injectCatalogue(engine, catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })]))
  armLoop(engine, state, "i1", "ses_loop", "free")

  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.equal(state.loops["ses_loop"].sessionIterations, 2)

  // The third turn hits the budget: the loop moves to the successor, whose
  // per-session count starts over while the loop's iteration count carries.
  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.equal(state.loops["ses_loop"], undefined)
  const next = state.loops["ses_new"]
  assert.ok(next, "the loop moved to the new session")
  assert.equal(next.sessionID, "ses_new")
  assert.equal(next.iterations, 3)
  assert.equal(next.sessionIterations, 0)
  assert.equal(next.sessionNumber, 1, "session number stays 1 since we no longer rotate")
  assert.match(next.lastResult ?? "", /rotated to ses_new after 3 turns \(session budget\)/)
  const prompt = fakes.prompts[fakes.prompts.length - 1]
  assert.equal(prompt.sessionID, "ses_new")
  assert.match(prompt.text, /Original task: task/)
  const created = fakes.created[fakes.created.length - 1]
  assert.equal(created.title, "task · loop 2", "the successor is named for its task and loop number")
  assert.deepEqual(fakes.removed, ["ses_loop"], "the retired session is deleted after rotation")
})

test("a failed delete of the retired session is non-fatal", async () => {
  const { engine, state } = makeEngine("i1", { sessionSteps: 1 })
  injectCatalogue(engine, catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })]))
  armLoop(engine, state, "i1", "ses_loop")
  const broken = fakeContext()
  ;(broken.context.session as unknown as { remove(input: { sessionID: string }): Promise<unknown> }).remove =
    async () => {
      throw new Error("remove rejected")
    }
  ;(engine as unknown as { ctx: unknown }).ctx = broken.context

  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.ok(state.loops["ses_new"], "the rotation still lands on the successor")
  assert.equal(state.loops["ses_loop"], undefined, "the loop record still moves to it")
})

test("the retired session delete retries once before giving up", async () => {
  const { engine, state } = makeEngine("i1", { sessionSteps: 1 })
  injectCatalogue(engine, catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })]))
  armLoop(engine, state, "i1", "ses_loop")
  const flaky = fakeContext()
  let calls = 0
  ;(flaky.context.session as unknown as { remove(input: { sessionID: string }): Promise<unknown> }).remove =
    async () => {
      calls += 1
      if (calls === 1) throw new Error("first attempt raced the settle")
    }
  ;(engine as unknown as { ctx: unknown }).ctx = flaky.context

  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.equal(calls, 2, "the remove is retried once")
  assert.ok(state.loops["ses_new"], "the rotation landed")
})

test("a rotation defers under a live subagent and is retried after", async () => {
  const { engine, state, fakes } = makeEngine("i1", { sessionSteps: 1 })
  injectCatalogue(engine, catalogueOf([row({ key: "a/x", providerID: "a", id: "x" })]))
  armLoop(engine, state, "i1", "ses_loop", "free")

  const busy = {
    session: {
      ...fakeContext().context.session,
      prompt: async (input: { sessionID: string; text: string }) => {
        fakes.prompts.push(input)
      },
      list: async (input?: { parentID?: string | null }) => ({
        data: input?.parentID === "ses_loop" ? [{ id: "ses_child", parentID: "ses_loop" }] : [],
      }),
      active: async () => ({ data: { ses_child: {} } }),
      context: async () => ({ data: [] }),
    },
  }
  ;(engine as unknown as { ctx: unknown }).ctx = busy
  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.ok(state.loops["ses_loop"], "the loop stays put while the subagent works")
  assert.match(state.loops["ses_loop"].lastResult ?? "", /rotation deferred/)

  // The subagent finishes: the remembered rotation is retried and succeeds.
  const clear = {
    session: {
      ...fakeContext().context.session,
      prompt: async (input: { sessionID: string; text: string }) => {
        fakes.prompts.push(input)
      },
      list: async () => ({ data: [] }),
      active: async () => ({ data: {} }),
      context: async () => ({ data: [] }),
    },
  }
  ;(engine as unknown as { ctx: unknown }).ctx = clear
  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.equal(state.loops["ses_loop"], undefined)
  assert.ok(state.loops["ses_new"])
})

test("context pressure rotates before the window fills", async () => {
  const { engine, state } = makeEngine("i1", { sessionSteps: 100 })
  injectCatalogue(engine, catalogueOf([row({ key: "a/x", providerID: "a", id: "x", context: 1_000 })]))
  armLoop(engine, state, "i1", "ses_loop", "free")
  const tracked = engine.trackedSessions().find((s) => s.sessionID === "ses_loop")!
  tracked.model = { providerID: "a", id: "x" }
  ;(engine as unknown as { ctx: unknown }).ctx = {
    session: {
      ...fakeContext().context.session,
      context: async () => ({ data: [
        { type: "assistant", tokens: { input: 850, output: 10, cache: { read: 0, write: 0 } } },
      ]}),
    },
  }

  await engine.onTurnEnd("ses_loop", "session.execution.succeeded")
  assert.equal(state.loops["ses_loop"], undefined)
  assert.ok(state.loops["ses_new"])
  assert.match(state.loops["ses_new"].lastResult ?? "", /context 85%/)
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
  assert.equal(await engine.rotate("ses_loop", "test"), "not-ours")
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

test("a stale teardown adopts a loop the file has already settled instead of re-toasting it", async () => {
  const { engine, state } = makeEngine("i1")
  armLoop(engine, state, "i1", "ses_loop")
  // The disk record was settled by someone else (an earlier teardown, a halt
  // intent) while this instance's memory still thinks the loop is active —
  // the shape every session-switch unload finds the plugin in.
  const disk = initialState()
  disk.loops["ses_loop"] = {
    ...state.loops["ses_loop"]!,
    status: "stopped",
    owner: null,
    ownerBeatAt: 0,
    lastResult: "loop stopped: plugin unloaded",
  }

  await engine.stop("plugin unloaded", undefined, disk)
  const loop = state.loops["ses_loop"]
  assert.equal(loop.status, "stopped")
  assert.equal(loop.lastResult, "loop stopped: plugin unloaded", "the file's report survives the teardown")
  assert.equal(state.intent.action, "none", "no halt intent is announced for an already-settled loop")
})

test("a stop that actually halts a loop still announces it", async () => {
  const { engine, state } = makeEngine("i1")
  armLoop(engine, state, "i1", "ses_loop")
  // The file agrees the loop is active: this stop is the first settlement.
  const disk = initialState()
  disk.loops["ses_loop"] = { ...state.loops["ses_loop"]! }

  await engine.stop("stopped by command", undefined, disk)
  assert.equal(state.loops["ses_loop"].lastResult, "stopped by command")
  assert.equal(state.intent.action, "halt", "an actual halt is announced on the control plane")
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