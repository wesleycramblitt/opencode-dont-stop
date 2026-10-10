/**
 * dont-stop — Apply.
 *
 * This is the module that fixes the root-cause bug. Changing an agent's
 * default model only affects sessions created *afterwards*: a running session
 * pins its own model in `Session.Info.model`, and that pin overrides the
 * agent default. So a profile switch that only rewrote the agent registry
 * appeared to do nothing on any live session.
 *
 * Two separate channels therefore have to be written, and they are not
 * interchangeable:
 *
 * 1. `ctx.agent.transform` — rewrites agent definitions so *new* sessions
 *    and subagents spawn on the right model.
 * 2. `ctx.session.switchModel({ sessionID, model })` — the one API that
 *    reaches a model already pinned on a live session.
 *
 * A complete apply does both. The plan carries what to set, and this module
 * owns nothing but the mechanics of pushing it.
 */

import type { Logger } from "./log.ts"
import { slotKey, type CatalogueModel } from "./catalogue.ts"
import type { ModelSlot, PluginState } from "./state.ts"

/** Which model each agent should run on, keyed by agent id. */
export interface ModelPlan {
  /** The primary/main session model. */
  main: ModelSlot | null
  /** Per-agent defaults for new sessions and subagents. */
  agents: Record<string, ModelSlot>
  /** Sessions whose pinned model should be switched, and to what. */
  sessions: Array<{ sessionID: string; model: ModelSlot }>
  /** Human-readable reasoning, for status output. */
  notes: string[]
}

/** The subset of the plugin context this module touches. */
export interface ApplyContext {
  agent: {
    transform(fn: (editor: {
      list(): readonly Array<{ id: string; model?: unknown }>
      update(id: string, update: (agent: { model?: unknown }) => void): void
    }) => void): Promise<unknown>
    reload(): Promise<unknown>
    list?(): Promise<{ data?: Array<{ id: string }> }>
  }
  session: {
    switchModel(input: { sessionID: string; model: ModelSlot }): Promise<unknown>
  }
}

export interface ApplyResult {
  /** Agents whose definition was rewritten. */
  agentsUpdated: string[]
  /** Sessions whose pinned model was switched. */
  sessionsSwitched: string[]
  /** Sessions that failed to switch, with reasons. */
  failures: Array<{ sessionID: string; reason: string }>
}

/**
 * Convert a catalogue row into the slot shape `switchModel` expects. The key
 * is derived from the row rather than passed in so a variant row carries its
 * variant through.
 */
export function slotFrom(model: CatalogueModel): ModelSlot {
  return model.variant
    ? { providerID: model.providerID, id: model.id, variant: model.variant }
    : { providerID: model.providerID, id: model.id }
}

/** Build a plan entry key. Kept here so apply and engine agree on it. */
export function planKeyFor(slot: ModelSlot): string {
  return slotKey(slot.providerID, slot.id, slot.variant)
}

/**
 * Apply agent defaults. This is channel 1: it affects sessions that have not
 * been created yet. It is idempotent — registering the same transform twice
 * yields the same agents — because the transform reads the plan through a
 * getter rather than capturing it.
 */
export async function applyAgentDefaults(
  ctx: ApplyContext,
  plan: () => ModelPlan,
): Promise<string[]> {
  const updated: string[] = []
  try {
    await ctx.agent.transform((editor) => {
      for (const agent of editor.list()) {
        const slot = plan().agents[agent.id]
        if (!slot) continue
        editor.update(agent.id, (target) => {
          target.model = { providerID: slot.providerID, id: slot.id, ...(slot.variant ? { variant: slot.variant } : {}) }
        })
        updated.push(agent.id)
      }
    })
  } catch (error) {
    // A failed agent transform is not fatal: the session channel below can
    // still reach live sessions.
    return updated
  }
  return updated
}

/**
 * Apply the session channel. This is channel 2 and the one that actually
 * fixes the reported bug: each tracked live session gets its pinned model
 * switched. Failures are collected, not thrown, so one dead session does not
 * stop the others from being updated.
 */
export async function applySessionModels(
  ctx: ApplyContext,
  sessions: Array<{ sessionID: string; model: ModelSlot }>,
  log?: Logger,
): Promise<ApplyResult> {
  const failures: ApplyResult["failures"] = []
  const sessionsSwitched: string[] = []

  for (const entry of sessions) {
    try {
      await ctx.session.switchModel({ sessionID: entry.sessionID, model: entry.model })
      sessionsSwitched.push(entry.sessionID)
    } catch (error) {
      const reason = errorMessage(error)
      failures.push({ sessionID: entry.sessionID, reason })
      log?.warn(`switchModel failed for ${entry.sessionID}: ${reason}`)
    }
  }

  return { agentsUpdated: [], sessionsSwitched, failures }
}

/**
 * Reload agents so the new defaults take effect. Agents declared in
 * `agents/*.md` are not in the registry when a plugin's transform first runs,
 * so the caller replays this shortly after startup.
 */
export async function reloadAgents(ctx: ApplyContext, log?: Logger): Promise<void> {
  try {
    await ctx.agent.reload()
  } catch (error) {
    log?.warn(`agent reload failed: ${errorMessage(error)}`)
  }
}

/** List agent ids from the context, tolerating an absent API. */
export async function agentIds(ctx: ApplyContext): Promise<string[]> {
  try {
    const result = await ctx.agent.list?.()
    return (result?.data ?? []).map((a) => a.id)
  } catch {
    return []
  }
}

/**
 * Diff a plan against the current state, returning only the sessions that
 * actually need a switch. Avoids spamming `switchModel` on every heartbeat
 * for sessions already on the right model.
 */
export function sessionsNeedingSwitch(
  plan: ModelPlan,
  state: PluginState,
  tracked: Map<string, { model: ModelSlot | null }>,
): Array<{ sessionID: string; model: ModelSlot }> {
  const out: Array<{ sessionID: string; model: ModelSlot }> = []
  for (const [sessionID, record] of tracked) {
    const target = plan.agents["__main__"] ?? plan.main
    if (!target) continue
    const current = record.model
    if (current && sameSlot(current, target)) continue
    out.push({ sessionID, model: target })
  }
  return out
}

/** Do two slots refer to the same model? */
export function sameSlot(a: ModelSlot, b: ModelSlot): boolean {
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? null) === (b.variant ?? null)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
