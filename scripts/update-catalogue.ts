#!/usr/bin/env -S npx tsx
/**
 * Update the model catalogue.
 *
 * Queries the live sources, joins them against the curated benchmark table,
 * and writes `data/catalogue.json`. Run this whenever models change:
 *
 *   npx tsx scripts/update-catalogue.ts
 *   npx tsx scripts/update-catalogue.ts --all        # include every provider
 *   npx tsx scripts/update-catalogue.ts --dry-run    # print a summary, write nothing
 *   npx tsx scripts/update-catalogue.ts --table      # print the full table
 *   npx tsx scripts/update-catalogue.ts --alibaba-key <key>
 *
 * The written file is checked in, so the catalogue is reproducible and does
 * not need network access at plugin load time.
 */

import { writeFileSync } from "node:fs"

import { fetchCatalogue, writeCatalogue, type CatalogueRow } from "../lib/fetch.ts"

interface Options {
  all: boolean
  dryRun: boolean
  table: boolean
  limit: number
  alibabaKey: string | undefined
}

function parseArgs(argv: string[]): Options {
  return {
    all: argv.includes("--all"),
    dryRun: argv.includes("--dry-run"),
    table: argv.includes("--table"),
    limit: numberAfter(argv, "--limit") ?? 40,
    alibabaKey: stringAfter(argv, "--alibaba-key") ?? undefined,
  }
}

function numberAfter(argv: string[], flag: string): number | null {
  const index = argv.indexOf(flag)
  if (index === -1) return null
  const value = Number(argv[index + 1])
  return Number.isFinite(value) ? value : null
}

function stringAfter(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  if (index === -1) return null
  return argv[index + 1] ?? null
}

const options = parseArgs(process.argv.slice(2))

console.log("[catalogue] fetching models.dev ...")
const started = Date.now()
const document = await fetchCatalogue({ alibabaKey: options.alibabaKey })

/* ------------------------------------------------------------- reporting */

const bySource = new Map<string, number>()
for (const model of document.models) bySource.set(model.provenance.metadata, (bySource.get(model.provenance.metadata) ?? 0) + 1)

const verified = document.models.filter((m) => !m.provenance.estimated)
const deprecated = document.models.filter((m) => m.provenance.estimated === false && m.benchmarks === null)

console.log(`[catalogue] ${document.models.length} models in ${Date.now() - started}ms`)
for (const source of document.sources) {
  const unreachable = source.id === "opencode-registry" && source.models === 0
  console.log(`  ${source.id}: ${source.models}${unreachable ? "  (server unreachable; everything left routable)" : ""}`)
}
for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
  console.log(`  metadata ${source}: ${count}`)
}
console.log(`[catalogue] ${verified.length} with curated benchmarks, ${deprecated.length} verified but unbenchmarked`)
console.log(`[catalogue] ${document.models.filter((m) => m.weights.total !== null).length} with parsed weights, ${document.models.filter((m) => m.weights.moe).length} MoE`)
const routable = document.models.filter((m) => m.reachable !== false)
console.log(`[catalogue] ${routable.length} routable from this install, ${document.models.length - routable.length} not`)

const providers = [...new Set(document.models.map((m) => m.providerID))].sort()
console.log(`[catalogue] providers: ${providers.join(", ")}`)
console.log(`[catalogue] routable providers: ${[...new Set(routable.map((m) => m.providerID))].sort().join(", ")}`)

if (options.table) {
  console.log("")
  console.log(renderTable(document.models.slice().sort((a, b) => b.scores.capability - a.scores.capability).slice(0, options.limit)))
}

/* --------------------------------------------------------------- writing */

if (options.dryRun) {
  console.log("[catalogue] dry run: nothing written")
} else {
  writeCatalogue(document)
  console.log(`[catalogue] wrote data/catalogue.json`)
}

/* --------------------------------------------------------------- warnings */

const noBenchmarks = verified.length === 0 && document.models.length > 0
if (noBenchmarks) {
  console.warn("[catalogue] warning: no model matched a curated benchmark row")
  console.warn("[catalogue]          add entries to data/benchmarks.ts keyed by canonical_model_id")
}

const empty = document.models.length === 0
if (empty) {
  console.error("[catalogue] error: no models fetched; check network access")
  process.exitCode = 1
}

function renderTable(rows: CatalogueRow[]): string {
  const header = ["model", "cap", "reas", "code", "agent", "gen", "ctx", "price", "flags"].join("  ")
  const lines = [header, "-".repeat(header.length)]
  for (const m of rows) {
    const price = m.pricing.input + m.pricing.output === 0 ? "free" : `${m.pricing.input}/${m.pricing.output}`
    const flags = [
      m.local ? "L" : "",
      m.capabilities.image ? "V" : "",
      m.capabilities.toolCall ? "T" : "",
      m.provenance.estimated ? "est" : "ver",
    ].join("")
    const ctx = m.context > 0 ? `${Math.round(m.context / 1000)}k` : "?"
    lines.push(
      [
        m.key.padEnd(42),
        String(m.scores.capability).padStart(5),
        String(m.scores.reasoning).padStart(5),
        String(m.scores.code).padStart(5),
        String(m.scores.agentic).padStart(5),
        String(m.scores.general).padStart(4),
        ctx.padStart(5),
        price.padStart(13),
        flags,
      ].join("  "),
    )
  }
  return lines.join("\n")
}
