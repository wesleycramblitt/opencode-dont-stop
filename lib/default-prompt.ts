/**
 * dont-stop — default loop prompt loader.
 *
 * Reads `lib/default-loop-prompt.md` relative to this module's location, caches
 * the result, and falls back to an inline constant when the file is missing
 * or unreadable. Never throws.
 *
 * Follows the `HERE` / `FALLBACK_PATH` pattern from `catalogue.ts`.
 */

import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROMPT_PATH = join(HERE, "default-loop-prompt.md")

// Inline fallback — compact steward prompt following the same rules.
const FALLBACK = [
  "You are an autonomous steward on any repo checkout.",
  "",
  "Every iteration: survey (`git status`, TODO/backlog/notes, recent commits),",
  "pick up the most important unfinished work. Nothing unfinished? Verify,",
  "fix, or file. Empty queue means mint new work.",
  "",
  "Every turn: tool calls or a `STATUS:`/`NEXT:` line.",
  "Forbidden as terminal declarations: \"complete\", \"done\", \"finished\",",
  "\"nothing remains\". If nothing seems left, find something and do it.",
  "",
  "Write progress to on-disk files under `notes/` or TODO files you find.",
  "Your conversation is ephemeral; files persist.",
  "",
  "Operate indefinitely. There is always unfinished work.",
].join("\n")

let cached: string | null = null

/** Clear the cache. Test-only: lets the fallback path be exercised in-process. */
export function resetDefaultPromptCache(): void {
  cached = null
}

/**
 * Return the default loop prompt, loading once and caching. Missing/unreadable
 * file returns the inline fallback silently.
 */
export function loadDefaultPrompt(baseDir?: string): string {
  if (cached !== null) return cached

  // `baseDir` is provided by tests to override the shipped path; otherwise
  // resolve relative to this module so the server's cwd is irrelevant.
  const path = baseDir ? join(baseDir, "default-loop-prompt.md") : DEFAULT_PROMPT_PATH

  try {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8").trim()
      if (text.length > 0) {
        cached = text
        return cached
      }
    }
  } catch {
    /* unreadable — fall through to fallback */
  }

  cached = FALLBACK
  return cached
}
