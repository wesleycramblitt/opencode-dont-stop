/**
 * Structured logging for dont-stop.
 *
 * Every log line goes to two places: the plugin log (a ring buffer in the
 * durable state file, so the TUI can show recent history) and stdout (so
 * headless and API users see it). The logger is deliberately dependency-free
 * and takes the state object as an argument rather than owning it, so both
 * plugin halves can share one implementation.
 */

import { appendLog, type PluginState } from "./state.ts"

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  /** Log with a state file entry but no stdout line (high-frequency events). */
  quiet(level: "info" | "warn" | "error", message: string): void
}

const PREFIX = "dont-stop"

export function createLogger(state: PluginState): Logger {
  const emit = (level: "info" | "warn" | "error", message: string, toStdout: boolean) => {
    appendLog(state, level, message)
    if (toStdout) {
      const line = `[${PREFIX}] ${level}: ${message}`
      if (level === "error") console.error(line)
      else console.log(line)
    }
  }

  return {
    info: (message) => emit("info", message, true),
    warn: (message) => emit("warn", message, true),
    error: (message) => emit("error", message, true),
    quiet: (level, message) => emit(level, message, false),
  }
}
