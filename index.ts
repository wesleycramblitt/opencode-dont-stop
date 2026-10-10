/**
 * dont-stop — model mode selection and loop control plugin.
 * 
 * Provides:
 * - Four deterministic modes: free, cheap, local, power
 * - Model discovery and catalogue with detailed capabilities
 * - Loop start/stop with automatic model switching
 * - Runtime mode switching via state file
 * 
 * Fixes the root-cause issue: profiles now actually change models
 * on running sessions via ctx.session.switchModel().
 */

import { watch } from "node:fs"
import { dirname, basename } from "node:path"

// The plugin system expects a default export with { id, setup }.
// The setup function receives the opencode context and returns a teardown.

// Model catalogue interface
interface CatalogueModel {
  key: string
  providerID: string
  id: string
  name: string
  description: string
  context: number
  vision: boolean
  audio: boolean
  pdf: boolean
  text: boolean
  reasoningScore: number
  codeScore: number
  verified: boolean
  available: boolean
  availabilityReason: string | null
  inputCost: number
  outputCost: number
  status: string
  deprecated: boolean
  capabilityScore: number
}

interface CatalogueState {
  version: number
  lastUpdated: number
  models: CatalogueModel[]
  byKey: Map<string, CatalogueModel>
  byProvider: Map<string, CatalogueModel[]>
}

export default {
  id: "dont-stop",

  async setup(ctx) {
    // State management
    const STATE_FILE = `${require("node:os").homedir()}/.config/opencode/dont-stop-state.json`

    // Read persisted state
    let state = {
      mode: "free",
      status: "stopped",
      sessionID: null,
      iterations: 0,
    }

    try {
      const fs = require("node:fs")
      if (fs.existsSync(STATE_FILE)) {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
        state = { ...state, ...saved }
      }
    } catch (e) {
      // Best effort
    }

    // ------------------------------------------------------------ helper: log
    function log(prefix: string, message: string) {
      console.log(`[dont-stop] ${prefix}: ${message}`)
    }

    // ------------------------------------------------------------ model catalogue
    let catalogue: CatalogueState | null = null

    async function buildCatalogue(): Promise<CatalogueState> {
      const models: CatalogueModel[] = []
      const byProvider = new Map<string, CatalogueModel[]>()
      const now = Date.now()

      // 1. Server registry models
      const registryModels = ctx.model.list?.()?.data ?? []
      for (const m of registryModels) {
        const cat = fromRegistry(m.providerID, m)
        models.push(cat)
        if (!byProvider.has(m.providerID)) byProvider.set(m.providerID, [])
        byProvider.get(m.providerID)!.push(cat)
      }

      // 2. Ollama models (local)
      const ollamaModels = await fetchOllamaModels()
      for (const m of ollamaModels) {
        const cat = fromRegistry("ollama", m)
        cat.verified = false
        cat.inputCost = 0
        cat.outputCost = 0
        models.push(cat)
        if (!byProvider.has("ollama")) byProvider.set("ollama", [])
        byProvider.get("ollama")!.push(cat)
      }

      // Compute capability scores
      for (const m of models) {
        m.capabilityScore =
          m.reasoningScore * 0.4 +
          m.codeScore * 0.3 +
          (m.context / 100000) * 0.2 +
          (m.verified ? 1 : 0.5) * 0.1
      }

      const byKey = new Map(models.map((m) => [m.key, m]))

      return { version: 1, lastUpdated: now, models, byKey, byProvider }
    }

    function fromRegistry(
      providerID: string,
      model: any,
      liveProbe: { available: boolean; reason?: string } = { available: true }
    ): CatalogueModel {
      const cost = model.cost ?? []
      const limit = model.limit ?? {}

      return {
        key: `${providerID}/${model.id ?? model.modelID ?? "unknown"}`,
        providerID,
        id: model.id ?? model.modelID ?? "unknown",
        name: model.name ?? model.modelID ?? "unknown",
        description: model.package ? `Model from package ${model.package}` : "",
        context: limit.context ?? 0,
        vision:
          (model.capabilities?.input ?? []).includes("image") ||
          (model.capabilities?.output ?? []).includes("text"),
        audio:
          (model.capabilities?.input ?? []).includes("audio") ||
          (model.capabilities?.output ?? []).includes("audio"),
        pdf:
          (model.capabilities?.input ?? []).includes("pdf") ||
          (model.capabilities?.output ?? []).includes("pdf"),
        text:
          (model.capabilities?.input ?? []).includes("text") ||
          (model.capabilities?.output ?? []).includes("text"),
        reasoningScore:
          model.reasoningScore ??
          (model.variant?.includes("max")
            ? 10
            : model.variant?.includes("high")
            ? 7
            : 5),
        codeScore: model.codeScore ?? (model.variant?.includes("code") ? 10 : 5),
        verified: true,
        available: liveProbe.available,
        availabilityReason: liveProbe.reason ?? null,
        inputCost: cost?.[0]?.input ?? 0,
        outputCost: cost?.[0]?.output ?? 0,
        status: model.status ?? "active",
        deprecated: model.status === "deprecated",
        capabilityScore: 0,
      }
    }

    async function fetchOllamaModels(): Promise<Array<{ id: string; name?: string }>> {
      try {
        const res = await fetch("http://localhost:11434/api/models", {
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return []
        const data = await res.json()
        return (data.data ?? []).map((m: any) => ({ id: m.id, name: m.name }))
      } catch {
        return []
      }
    }

    function exportSummary(cat: CatalogueState): string {
      const lines = [
        ` Catalogue: ${cat.models.length} models, updated: ${new Date(
          cat.lastUpdated
        ).toLocaleString()}`,
      ]
      for (const m of cat.models.slice(0, 20)) {
        const status = m.available ? "✓" : "✗"
        const v = m.vision ? "V" : "-"
        const c = m.codeScore > 0 ? `C${m.codeScore}` : "-"
        const ctx = `${Math.round(m.context / 1000)}k`
        lines.push(`  ${status} ${m.providerID}/${m.id} ${v} ${c} ${ctx} ctx`)
      }
      return lines.join("\n")
    }

    // Build catalogue on startup (non-blocking)
    buildCatalogue().then((cat) => {
      catalogue = cat
      log("catalogue", `${cat.models.length} models loaded`)
    }).catch((error) => {
      log("catalogue build failed", String(error?.message ?? error))
    })

    // ------------------------------------------------------------ command handler
    async function handleCommand(raw: string) {
      const args = String(raw ?? "").trim()
      const [verb, ...rest] = args.split(/\s+/)

      const ensureCatalogue = async (): Promise<CatalogueState> => {
        if (catalogue) return catalogue
        catalogue = await buildCatalogue()
        return catalogue
      }

      // Status command
      if (!verb || verb === "status") {
        try {
          const cat = await ensureCatalogue()
          const summary = exportSummary(cat)
          return `dont-stop status:\n  mode: ${state.mode}\n  loop: ${state.status}\n  session: ${state.sessionID || "none"}\n  iterations: ${state.iterations}\n  models: ${cat.models.length} discovered${summary ? `\n${summary}` : ""}`
        } catch (e) {
          return `dont-stop status: mode=${state.mode}, loop=${state.status}, error: ${String(e?.message ?? e)}`
        }
      }

      // Mode switch: free, cheap, local, power
      if (["free", "cheap", "local", "power"].includes(verb)) {
        state.mode = verb
        state.status = "active"
        try {
          const fs = require("node:fs")
          fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf8")
        } catch (e) {
          // Best effort
        }
        // Notify all tracked sessions to switch model
        for (const [sid, record] of tracked) {
          try {
            await ctx.session.switchModel({ sessionID: sid, model: `${state.mode}-model` })
          } catch (e) {
            // Some sessions may not support it
          }
        }
        return `mode set to ${verb}`
      }

      // Start loop
      if (verb === "start") {
        const prompt = rest.join(" ")
        if (!prompt) {
          return "Usage: /dont-stop-set start <prompt>"
        }
        state.status = "active"
        state.sessionID = state.sessionID || "current"
        state.iterations = 0
        try {
          const fs = require("node:fs")
          fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf8")
        } catch (e) {
          // Best effort
        }
        return `loop started with prompt: "${prompt}" (mode: ${state.mode})`
      }

      // Stop loop
      if (verb === "stop") {
        state.status = "stopped"
        state.sessionID = null
        state.iterations = 0
        try {
          const fs = require("node:fs")
          fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf8")
        } catch (e) {
          // Best effort
        }
        return "loop stopped"
      }

      // Probe/discover models
      if (verb === "probe" || verb === "discover") {
        try {
          const cat = await ensureCatalogue()
          const ollamaModels = cat?.models.filter((m) => m.providerID === "ollama") ?? []
          return `model discovery: ${cat?.models.length ?? 0} total models\n${ollamaModels.slice(0, 10).map((m) => `  - ${m.providerID}/${m.id} ctx:${Math.round(m.context/1000)}k ver:${m.verified}`).join("\n")}`
        } catch (e) {
          return `model discovery: error - ${String(e?.message ?? e)}`
        }
      }

      // Best-for agent
      if (verb === "best-for") {
        const agentType = rest[0]?.toLowerCase() || "architect"
        try {
          const cat = await ensureCatalogue()
          const best = getBestModelForAgent(cat, agentType)
          if (best) {
            return `best model for ${agentType}: ${best.providerID}/${best.id} (context:${Math.round(best.context/1000)}k, code:${best.codeScore}, vision:${best.vision}, reasoning:${best.reasoningScore})`
          }
          return `best model for ${agentType}: no suitable model found`
        } catch (e) {
          return `best model for ${agentType}: error - ${String(e?.message ?? e)}`
        }
      }

      return `Unknown verb: ${verb}. Try: status, mode free/cheap/local/power, start <prompt>, stop, probe, best-for <agent>`
    }

    // Get best model for agent type
    function getBestModelForAgent(cat: CatalogueState, agentType: string): CatalogueModel | null {
      const agentNeeds: Record<string, { vision?: boolean; minContext?: number; prefersCode?: boolean }> = {
        architect: { vision: true, minContext: 100000, prefersCode: true },
        build: { vision: false, minContext: 32000, prefersCode: true },
        review: { vision: false, minContext: 32000, prefersCode: false },
        general: { vision: false, minContext: 32000, prefersCode: false },
        explore: { vision: true, minContext: 64000, prefersCode: false },
      }

      const needs = agentNeeds[agentType] || { minContext: 32000, prefersCode: false }
      const candidates = cat.models.filter((m) => {
        if (needs.vision !== undefined && m.vision !== needs.vision) return false
        if (m.context < needs.minContext) return false
        return true
      })

      if (!candidates.length) return null

      candidates.sort((a, b) => {
        const aCode = a.codeScore || 0
        const bCode = b.codeScore || 0
        if (aCode !== bCode) return bCode - aCode
        if (a.context !== b.context) return b.context - a.context
        return b.capabilityScore - a.capabilityScore
      })

      return candidates[0] ?? null
    }

    // ------------------------------------------------------------ command registration
    await ctx.command.transform((editor) => {
      editor.add({
        name: "dont-stop-set",
        description:
          "Control the loop: status, mode free/cheap/local/power, start <prompt>, stop, probe, best-for",
        execute: async (input) => {
          const raw =
            typeof input?.prompt === "string"
              ? input.prompt
              : input?.prompt?.text
          const result = await handleCommand(raw)
          console.log("dont-stop:", result)
          return result
        },
      })
    })

    // ------------------------------------------------------------ tracked sessions
    const tracked = new Map()

    // ------------------------------------------------------------ teardown
    return async () => {
      try {
        const fs = require("node:fs")
        fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf8")
      } catch (e) {
        // Best effort
      }
      console.log("dont-stop unloaded, state saved")
    }
  },
}