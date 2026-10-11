/**
 * dont-stop — Error classification.
 *
 * A failed request is not just a failure; the *kind* of failure decides what
 * the loop does next. A rate limit means wait and rotate. Insufficient funds
 * means stop paying and drop to a cheaper mode. A capability error means the
 * model cannot do this task and must never be selected for it again.
 *
 * Classification is regex-based over the provider's error string plus the
 * HTTP status when present. It is deliberately the first thing that runs on
 * an error, because every recovery path depends on the verdict.
 */

import type { Catalogue } from "./catalogue.ts"
import type { Mode } from "./state.ts"

export type ErrorKind =
  | "interrupted"
  | "funds"
  | "rate"
  | "capability"
  | "notfound"
  | "context"
  | "auth"
  | "network"
  | "other"

export interface ClassifiedError {
  kind: ErrorKind
  /** The original message, kept for the log and for pattern improvement. */
  message: string
  /** HTTP status when the provider reported one. */
  status?: number
  /** True when retrying the same model could plausibly succeed later. */
  transient: boolean
}

/** What the loop should do about a classified error. */
export interface ErrorAction {
  /** Put the failing model on cooldown so rotation moves past it. */
  cooldownMs: number
  /** Force a re-sweep of the mode's candidate chain. */
  resweep: boolean
  /** Drop to a cheaper mode, if the error justifies it. */
  degrade: boolean
  /** Pin the session to a pool that avoids the failing capability. */
  restrict: null | "no-vision" | "no-tools" | "text-only"
  /** Stop the loop outright. */
  stop: boolean
  /**
   * The *same* model could plausibly succeed on a second attempt, so the loop
   * retries it once before rotating. False for failures that are facts about
   * the model — a capability miss, an exceeded context, a deleted model —
   * where a second attempt would only cost time.
   */
  retry: boolean
  /** Short explanation for status output. */
  reason: string
}

interface Pattern {
  kind: ErrorKind
  test: RegExp
  transient: boolean
}

/**
 * Ordered most-specific first: the first match wins, so a message that says
 * both "rate limit" and "insufficient funds" is judged by whichever pattern
 * appears earlier here.
 *
 * `interrupted` leads: a cancelled request is the loop's own doing (or the
 * user's), and scoring it as a failure is what used to send recovery into a
 * spin — the interrupt that unstuck a turn came back as an "unclassified
 * error" and bought another rotation.
 */
const PATTERNS: Pattern[] = [
  { kind: "interrupted", test: /\binterrupt(ed|ion|ing)?\b|\baborted?\b|cancel(led|ed)/i, transient: true },
  { kind: "funds", test: /insufficient[ _-]?(funds|balance|credit|quota)|billing|payment required|no credits|exceeded your (current )?quota/i, transient: false },
  { kind: "rate", test: /rate ?limit|too many requests|429|slow down|throttl|retry after|quota exceeded for|resource exhausted/i, transient: true },
  { kind: "context", test: /context ?(length|window|limit)|maximum context|too long|prompt is too (long|large)|exceeds? (the )?max(imum)? context|tokens? (exceed|limit)/i, transient: false },
  { kind: "capability", test: /does not support|unsupported|not support|capability|vision|image input|tool (call|use)|function call|invalid (model|modality)|modality|cannot process|no such tool/i, transient: false },
  { kind: "notfound", test: /not found|404|does not exist|no such model|unknown model|model .* not available|deleted|deprecated model/i, transient: false },
  { kind: "auth", test: /unauthori[sz]ed|401|403|invalid api key|forbidden|authentication|permission denied/i, transient: false },
  { kind: "network", test: /network|econnreset|econnrefused|etimedout|timeout|socket|fetch failed|dns|unreachable|connection (reset|closed|error)/i, transient: true },
]

/** Status codes that imply a kind even when the message is unhelpful. */
const STATUS_KINDS: Record<number, ErrorKind> = {
  401: "auth",
  403: "auth",
  404: "notfound",
  408: "network",
  413: "context",
  429: "rate",
  402: "funds",
  // 499 is the conventional "client closed request": it can only be our own
  // interrupt, so it is not the model's fault and must not trigger recovery.
  499: "interrupted",
}

/** Classify an error from the session retry hook or a caught exception. */
export function classify(input: {
  message?: string
  status?: number
  type?: string
  error?: unknown
}): ClassifiedError {
  const message = input.message ?? messageOf(input.error) ?? ""
  const status = input.status ?? statusOfError(input.error)
  const type = (input.type ?? "").toLowerCase()

  let kind: ErrorKind = "other"

  // The provider's declared error type is the strongest signal.
  if (type) {
    if (/interrupt|abort|cancel/.test(type)) kind = "interrupted"
    else if (/fund|billing|credit|quota|payment/.test(type)) kind = "funds"
    else if (/rate|throttl|limit/.test(type)) kind = "rate"
    else if (/context|length|token/.test(type)) kind = "context"
    else if (/capab|modality|support|vision|tool/.test(type)) kind = "capability"
    else if (/not.?found|missing|unknown/.test(type)) kind = "notfound"
    else if (/auth|permission|forbidden/.test(type)) kind = "auth"
    else if (/network|timeout|connection/.test(type)) kind = "network"
  }

  // Then the status code, then the message body.
  if (kind === "other" && status !== undefined && STATUS_KINDS[status]) {
    kind = STATUS_KINDS[status]
  }
  if (kind === "other" && message) {
    for (const pattern of PATTERNS) {
      if (pattern.test.test(message)) {
        kind = pattern.kind
        break
      }
    }
  }

  const transient = kind === "rate" || kind === "network" || kind === "other" || kind === "interrupted"
  return { kind, message, status, transient }
}

/** Decide what to do about a classified error, given the current mode. */
export function actionFor(error: ClassifiedError, mode: Mode): ErrorAction {
  switch (error.kind) {
    case "interrupted":
      // Not a failure. The request was cancelled — by this plugin's own hang
      // recovery, or by the user pressing escape. Cooldowns and rotation are
      // what made a single interrupt spin into several: the same model got
      // re-selected, got interrupted again, and the loop never learned
      // anything. Do nothing but record it.
      return {
        cooldownMs: 0,
        resweep: false,
        degrade: false,
        restrict: null,
        stop: false,
        retry: false,
        reason: "request interrupted; not a model failure",
      }

    case "funds":
      return {
        cooldownMs: 60 * 60 * 1000,
        resweep: true,
        degrade: true,
        restrict: null,
        stop: false,
        // The account is out of money: a second attempt fails the same way.
        retry: false,
        reason: "insufficient funds; degrading to a cheaper mode",
      }

    case "rate":
      return {
        // Long enough to survive a burst limit, short enough not to stall.
        // The limit clears, the cooldown expires, and `expireCooldowns` puts
        // the model back into contention — which is the "try again on free"
        // path: the sweep moves on *now* instead of waiting out the window on
        // a model that is refusing work.
        cooldownMs: 60 * 1000,
        resweep: true,
        degrade: false,
        restrict: null,
        stop: false,
        // No retry on the same model: a rate limit is a statement about the
        // model right now, and when several free models are waiting in the
        // chain the cheap move is to hand the turn to the next one. When the
        // window has no other model the rotation is a no-op and the cooldown
        // expiry brings this one back.
        retry: false,
        reason: "rate limited; rotating to the next model",
      }

    case "capability":
      return {
        // A capability miss is a fact about this task, not a flake: pin the
        // session to a pool that avoids the missing capability rather than
        // merely cooling the model down.
        cooldownMs: 5 * 60 * 1000,
        resweep: true,
        degrade: false,
        restrict: restrictionFor(error.message),
        stop: false,
        retry: false,
        reason: "model lacks a required capability; restricting the pool",
      }

    case "context":
      return {
        cooldownMs: 0,
        resweep: true,
        degrade: false,
        restrict: null,
        stop: false,
        retry: false,
        reason: "context exceeded; rotating to a larger-context model",
      }

    case "notfound":
      return {
        // The model is gone: never try it again this session.
        cooldownMs: 24 * 60 * 60 * 1000,
        resweep: true,
        degrade: false,
        restrict: null,
        stop: false,
        retry: false,
        reason: "model not found; rotating past it",
      }

    case "auth":
      return {
        cooldownMs: 15 * 60 * 1000,
        resweep: true,
        // Auth failures usually affect a whole provider, so a cheaper mode on
        // a different provider is the useful escape.
        degrade: true,
        restrict: null,
        stop: false,
        retry: false,
        reason: "authorization failed; rotating to another provider",
      }

    case "network":
      return {
        cooldownMs: 15 * 1000,
        resweep: true,
        degrade: false,
        restrict: null,
        stop: false,
        // A dropped connection is the most transient thing there is.
        retry: true,
        reason: "network error; will retry shortly",
      }

    case "other":
    default:
      return {
        cooldownMs: 30 * 1000,
        resweep: true,
        degrade: false,
        restrict: null,
        stop: false,
        // Unclassified is a guess; one attempt turns a guess into evidence.
        retry: true,
        reason: "unclassified error; rotating",
      }
  }
}

/** Which pool restriction a capability error implies. */
function restrictionFor(message: string): ErrorAction["restrict"] {
  if (/vision|image|multimodal/i.test(message)) return "no-vision"
  if (/tool|function/i.test(message)) return "no-tools"
  return "text-only"
}

/** Apply a restriction to a requirement set. */
export function applyRestriction(
  req: { vision?: boolean; toolCall?: boolean; audio?: boolean; pdf?: boolean; video?: boolean },
  restrict: ErrorAction["restrict"],
): void {
  if (restrict === "no-vision") req.vision = false
  else if (restrict === "no-tools") req.toolCall = false
  else if (restrict === "text-only") {
    req.vision = false
    req.audio = false
    req.pdf = false
    req.video = false
    req.toolCall = false
  }
}

/** Pull a message out of anything throwable. */
function messageOf(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    if (typeof record.message === "string") return record.message
    if (typeof record.error === "string") return record.error
  }
  return undefined
}

/** Pull an HTTP status out of anything throwable, when it carries one. */
function statusOfError(error: unknown): number | undefined {
  if (typeof error === "number") return error
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    for (const key of ["status", "statusCode", "code"]) {
      const value = record[key]
      if (typeof value === "number" && Number.isFinite(value)) return value
    }
    const nested = record.error ?? record.cause
    if (nested && nested !== error) return statusOfError(nested)
  }
  return undefined
}

/**
 * How many consecutive unclassified/other errors before the loop gives up.
 * Classified transient errors do not count toward this.
 */
export const MAX_CONSECUTIVE_ERRORS = 5

/** Should the accumulated error count stop the loop? */
export function shouldStop(count: number): boolean {
  return count >= MAX_CONSECUTIVE_ERRORS
}

/** Does this error count toward the consecutive-failure budget? */
export function countsTowardStop(error: ClassifiedError): boolean {
  return error.kind === "other" || error.kind === "auth"
}

/** Short human description of an error kind, for logs and status. */
export function describeError(kind: ErrorKind): string {
  switch (kind) {
    case "interrupted": return "request interrupted"
    case "funds": return "insufficient funds"
    case "rate": return "rate limited"
    case "context": return "context exceeded"
    case "capability": return "capability mismatch"
    case "notfound": return "model not found"
    case "auth": return "authorization failed"
    case "network": return "network error"
    case "other": return "unclassified error"
  }
}

/** Convenience: classify and decide in one step. */
export function classifyAndAct(input: Parameters<typeof classify>[0], mode: Mode): {
  error: ClassifiedError
  action: ErrorAction
} {
  const error = classify(input)
  return { error, action: actionFor(error, mode) }
}

/** Re-export for callers that only need the catalogue type. */
export type { Catalogue }
