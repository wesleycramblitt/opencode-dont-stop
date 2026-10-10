#!/usr/bin/env -S npx tsx
/**
 * Scrape the ollama popularity list.
 *
 * `ollama.com/search?o=popular` is client-rendered: the initial HTML carries
 * only the first 20 models and the rest load on scroll, so a plain `fetch`
 * cannot see them. This script drives a real browser through the
 * `brave-devtools` MCP server, scrolls until the list stops growing, and
 * writes the top N models — with context window, parameter size, capability
 * tags and description — to `data/ollama-popular.json`.
 *
 * `scripts/update-catalogue.ts` reads that file. It does not need a browser,
 * so the normal update path stays pure network I/O; this script is the one
 * step that requires one, and is run deliberately when the popularity list is
 * stale:
 *
 *   npx tsx scripts/scrape-ollama.ts --limit 100
 *
 * Requirements: a Brave instance reachable by the brave-devtools MCP server.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const OUTPUT = join(HERE, "..", "data", "ollama-popular.json")

const SEARCH_URL = "https://ollama.com/search?o=popular&c=text"
const MAX_CONTEXT = 4_000_000 // A context window above this is a mis-parse.

interface ScrapedModel {
  rank: number
  name: string
  context: number
  parameterSize: string
  capabilities: string[]
  description: string
}

interface PopularDocument {
  version: number
  scrapedAt: string
  source: string
  models: ScrapedModel[]
}

/**
 * The browser-side extraction. Runs as a single function in the page: scroll
 * to force the infinite loader, then read each list item.
 *
 * Kept as a plain string so it can be pasted into any devtools MCP without a
 * dependency on one particular client.
 */
const EXTRACT = `async () => {
  // Let the initial render settle, then push the infinite loader.
  await new Promise(r => setTimeout(r, 2500));
  for (let i = 0; i < 10; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 700));
  }

  const items = [...document.querySelectorAll('li')]
    .filter(li => li.querySelector('a[href^="/library/"]'));
  const out = [];
  const seen = new Set();

  for (const li of items) {
    const a = li.querySelector('a[href^="/library/"]');
    const name = a.getAttribute('href').replace('/library/', '');
    if (seen.has(name)) continue;
    seen.add(name);

    const text = (li.innerText || '').replace(/\\s+/g, ' ').trim();
    const body = text.slice(name.length).trim();

    // The trailing number in the tag row is the context window.
    const trailing = /([\\d.]+)\\s*([KM])\\b(?=\\s*$)/.exec(body);
    let context = 0;
    if (trailing) {
      context = Math.round(parseFloat(trailing[1]) * (trailing[2] === 'M' ? 1000000 : 1000));
    }
    if (!context) {
      const inline = /([\\d.]+)\\s*([KM])\\s*context/i.exec(body);
      if (inline) context = Math.round(parseFloat(inline[1]) * (inline[2] === 'M' ? 1000000 : 1000));
    }

    // Parameter size, e.g. "18b" -> "18B".
    const size = /\\b(\\d+(?:\\.\\d+)?)[bB]\\b/.exec(body);

    // Capability tags, matching whole words only.
    const caps = [];
    for (const c of ['vision','tools','thinking','embedding','audio','decision','cloud']) {
      if (new RegExp('\\\\b' + c + '\\\\b').test(body)) caps.push(c);
    }

    // Description: prose before the tag soup.
    const prose = /^([A-Z][^]*?\\.)(?=\\s+(?:[a-z]+\\s+)*[\\d.]+[bBmMK]\\b|$)/.exec(body);

    out.push({
      rank: out.length + 1,
      name,
      context,
      parameterSize: size ? size[1] + 'B' : '',
      capabilities: caps,
      description: (prose ? prose[1] : body.slice(0, 120)).slice(0, 160),
    });

    if (out.length >= LIMIT_PLACEHOLDER) break;
  }

  return JSON.stringify(out);
}`.replace("LIMIT_PLACEHOLDER", "200")

/* ---------------------------------------------------------------------- run */

function parseArgs(argv: string[]): { limit: number; pageId: number; dryRun: boolean } {
  const limit = Number(argv[argv.indexOf("--limit") + 1])
  const pageId = Number(argv[argv.indexOf("--page") + 1])
  return {
    limit: Number.isFinite(limit) ? limit : 100,
    pageId: Number.isFinite(pageId) ? pageId : 1,
    dryRun: argv.includes("--dry-run"),
  }
}

const options = parseArgs(process.argv.slice(2))

/**
 * The MCP client is injected so this script does not depend on one transport.
 * Wire it up however the devtools server is reachable, then run:
 *
 *   npx tsx scripts/scrape-ollama.ts
 *
 * With no client available the script explains itself and exits rather than
 * writing an empty file.
 */
async function main(): Promise<void> {
  const client = (globalThis as { __devtools?: DevtoolsClient }).__devtools
  if (!client) {
    console.error("[scrape-ollama] no brave-devtools client available")
    console.error("[scrape-ollama] this step needs a real browser because the list loads on scroll")
    console.error("[scrape-ollama] wire a client onto globalThis.__devtools and re-run, or use the")
    console.error("[scrape-ollama] saved data/ollama-popular.json, which update-catalogue.ts reads")
    process.exitCode = 1
    return
  }

  const existing = loadExisting()
  console.log(`[scrape-ollama] navigating to ${SEARCH_URL}`)
  await client.navigate(options.pageId, SEARCH_URL)

  const raw = await client.evaluate(options.pageId, EXTRACT)
  const scraped = JSON.parse(raw) as Array<Record<string, unknown>>

  const models: ScrapedModel[] = scraped
    .slice(0, options.limit)
    .map((entry, index) => {
      const context = Number(entry.context ?? 0)
      return {
        rank: index + 1,
        name: String(entry.name ?? ""),
        // A context above the cap is a mis-parse of a download count.
        context: context > 0 && context <= MAX_CONTEXT ? context : 0,
        parameterSize: String(entry.parameterSize ?? ""),
        capabilities: Array.isArray(entry.capabilities) ? (entry.capabilities as string[]) : [],
        description: String(entry.description ?? ""),
      }
    })
    .filter((m) => m.name.length > 0)

  if (models.length === 0) {
    console.error("[scrape-ollama] no models extracted; is the page loading?")
    process.exitCode = 1
    return
  }

  const document: PopularDocument = {
    version: 1,
    scrapedAt: new Date().toISOString(),
    source: SEARCH_URL,
    models,
  }

  if (options.dryRun) {
    console.log(`[scrape-ollama] ${models.length} models (dry run)`)
    for (const m of models.slice(0, 10)) {
      console.log(`  ${String(m.rank).padStart(3)}  ${m.name.padEnd(30)} ctx ${m.context || "?"}  ${m.capabilities.join(",")}`)
    }
    return
  }

  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, "utf8")
  console.log(`[scrape-ollama] wrote ${models.length} models to data/ollama-popular.json`)

  const dropped = scraped.length - models.length
  if (dropped > 0) console.log(`[scrape-ollama] dropped ${dropped} unparsed rows`)
  if (existing && existing.models.length > 0 && existing.models.length !== models.length) {
    console.log(`[scrape-ollama] previous run had ${existing.models.length} models`)
  }
}

function loadExisting(): PopularDocument | null {
  if (!existsSync(OUTPUT)) return null
  try {
    return JSON.parse(readFileSync(OUTPUT, "utf8")) as PopularDocument
  } catch {
    return null
  }
}

interface DevtoolsClient {
  navigate(pageId: number, url: string): Promise<unknown>
  evaluate(pageId: number, source: string): Promise<string>
}

void main()
