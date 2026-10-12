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
  | "freequota"
  | "rate"
  | "capability"
  | "notfound"
  | "deprecated"
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

/**
 * A free model that failed stays out of the sweep for a full day.
 *
 * Free endpoints fail at the door: a provider-wide rate limit, an exhausted
 * promotional quota, a dropped socket on a hosted free tier. None of those
 * clear in seconds, and the observed cost of the old 60s/15s/30s windows was a
 * loop that handed the same refused model its turn again — and again — instead
 * of walking the sweep. One try, one day out.
 */
export const FREE_MODEL_TIMEOUT_MS = 24 * 60 * 60 * 1000

/**
 * A free model whose promotional quota is spent is out for good.
 *
 * The allowance is gone for the grant's whole window (91 days), so waiting
 * does not bring it back: putting it on cooldown is what the sweep needed, and
 * a timeout is the cooldown shape the rest of this module already speaks. It
 * survives restarts, which is the point — a spent quota is not a flake — and a
 * mode change clears it, because the free sweep is the only reason the model
 * was excluded (in `cheap` the same model is a paid row and is selectable).
 */
export const PERMANENT_COOLDOWN_MS = Number.MAX_SAFE_INTEGER

/**
 * How long an insufficient-funds mark on one provider stays meaningful (24h).
 *
 * The rule for a mode change is two providers out at once; a mark older than
 * this is a memory of an account that may have been topped up since, so it
 * stops counting toward the second provider.
 */
export const FUNDS_PROVIDER_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * A model the provider says is deprecated is out everywhere, permanently.
 *
 * Distinct from the free-quota sentinel on purpose: a spent quota is a fact
 * about the *free sweep* (lifted when the mode leaves `free`), while a
 * deprecated model is a fact about the model itself — no mode will ever want
 * it again, so nothing lifts this one.
 */
export const DEPRECATED_COOLDOWN_MS = Number.MAX_SAFE_INTEGER - 1

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
 *
 * `freequota` sits above `funds` because it is the narrower fact: an
 * exhausted promotional allowance says nothing about the account's balance,
 * and answering it with "out of money" would degrade a mode that still has
 * plenty of paid models behind it.
 */
const PATTERNS: Pattern[] = [
  { kind: "interrupted", test: /\binterrupt(ed|ion|ing)?\b|\baborted?\b|cancel(led|ed)/i, transient: true },
  { kind: "freequota", test: /free[ _-]?quota|promotional (quota|allowance|tier)|quota .{0,40}(exhaust|depleted|used up|ran out)|(exhaust|depleted|used up|ran out).{0,40}quota|free tier limit/i, transient: false },
  { kind: "funds", test: /insufficient[ _-]?(funds|balance|credit|quota)|billing|payment required|no credits|exceeded your (current )?quota|arrear|account balance|balance is insufficient|insufficient (account )?balance/i, transient: false },
  { kind: "rate", test: /rate ?limit|too many requests|429|slow down|throttl|retry after|quota exceeded for|resource exhausted/i, transient: true },
  // Deprecated leads notfound: "model has been deprecated" says the row is
  // gone for good, not merely missing.
  { kind: "deprecated", test: /deprecat/i, transient: false },
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

  const byType = type ? kindOfType(type) : undefined
  const byStatus = status !== undefined ? STATUS_KINDS[status] : undefined
  // The message outranks both the type and the status, and the order matters:
  // an `AI.Error` from the AI SDK carries a *class* name that is coarser than
  // the failure it reports, and a status wrapped by a proxy can belong to a
  // different failure than the sentence describes. Both were observed calling
  // "Rate limit exceeded. Please try again later." a *funds* error — which
  // bought a mode degrade instead of a rotation. The provider's own words are
  // the fact; the labels are hints. `interrupted` leads the message patterns
  // so the loop's own cancellation is never scored as a failure.
  const byMessage = message ? firstMatch(message) : undefined
  const kind = byMessage ?? byType ?? byStatus ?? "other"

  const transient = kind === "rate" || kind === "network" || kind === "other" || kind === "interrupted"
  return { kind: kind as ClassifiedError["kind"], message, status, transient }
}

/** The kind a message's own wording names, or undefined when it says none. */
function firstMatch(message: string): ErrorKind | undefined {
  for (const pattern of PATTERNS) if (pattern.test.test(message)) return pattern.kind
  return undefined
}

/** The kind a provider error *type* string names. */
function kindOfType(type: string): ErrorKind | undefined {
  if (/interrupt|abort|cancel/.test(type)) return "interrupted"
  if (/free[ _-]?quota|promotional/.test(type)) return "freequota"
  if (/fund|billing|credit|quota|payment/.test(type)) return "funds"
  if (/rate|throttl|limit/.test(type)) return "rate"
  if (/deprecat/.test(type)) return "deprecated"
  if (/context|length|token/.test(type)) return "context"
  if (/capab|modality|support|vision|tool/.test(type)) return "capability"
  if (/not.?found|missing|unknown/.test(type)) return "notfound"
  if (/auth|permission|forbidden/.test(type)) return "auth"
  if (/network|timeout|connection/.test(type)) return "network"
  return undefined
}

/** Decide what to do about a classified error, given the current mode. */
export function actionFor(error: ClassifiedError, mode: Mode): ErrorAction {
  const action = actionForKind(error.kind, error.message)
  if (error.kind === "interrupted") return action
  if (mode !== "free") return action

  // The free-sweep policy (owner, 2026-10-11): one try per free endpoint,
  // then it stays out of the sweep. A spent promotional quota is out for the
  // grant's whole window — PERMANENT_COOLDOWN_MS — which is different in kind
  // from a transient failure: the model is not down, it is no longer free. Any
  // other failure gets a full day, and nothing in the free sweep ever gets a
  // second attempt from a retry flag. Rotation is the recovery: every turn
  // walks to the next untried model, and the cooldown expiry — or a mode
  // change, which clears permanent entries — is what brings one back.
  if (error.kind === "freequota") {
    return {
      ...action,
      cooldownMs: PERMANENT_COOLDOWN_MS,
      reason: "free quota exhausted; model stays out of the free sweep",
    }
  }
  return {
    ...action,
    retry: false,
    cooldownMs: Math.max(action.cooldownMs, FREE_MODEL_TIMEOUT_MS),
    reason: `${action.reason} — free policy: one day out of the sweep`,
  }
}

/** The base action per kind, before the mode's policy is applied. */
function actionForKind(kind: ErrorKind, message: string): ErrorAction {
  switch (kind) {
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
        // The account is out of money: drop to a cheaper mode, and stay there
        // until the user brings it back — the owner's policy is that a mode
        // degraded away is not self-reinstated.
        degrade: true,
        restrict: null,
        stop: false,
        // A second attempt fails the same way.
        retry: false,
        reason: "insufficient funds; degrading to a cheaper mode",
      }

    case "freequota":
      return {
        // Outside the free sweep this is a fact about the promotional grant,
        // not the account: rotate past the model for the rest of the hour. In
        // `free` mode `actionFor` turns this into PERMANENT_COOLDOWN_MS.
        cooldownMs: 60 * 60 * 1000,
        resweep: true,
        degrade: false,
        restrict: null,
        stop: false,
        retry: false,
        reason: "promotional free quota exhausted; rotating past it",
      }

    case "rate":
      return {
        // Long enough to survive a burst limit, short enough not to stall.
        // The limit clears, the cooldown expires, and `expireCooldowns` puts
        // the model back into contention — which is the "try again on free"
        // path: the sweep moves on *now* instead of waiting out the window on
        // a model that is refusing work. In `free` mode `actionFor` lengthens
        // this to a full day; this value is the paid-mode policy.
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
        restrict: restrictionFor(message),
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

    case "deprecated":
      return {
        // The provider says the row is deprecated: out of every mode,
        // permanently, and nothing lifts it (not even leaving the free
        // sweep — a spent quota is a fact about the sweep, this is a fact
        // about the model).
        cooldownMs: DEPRECATED_COOLDOWN_MS,
        resweep: true,
        degrade: false,
        restrict: null,
        stop: false,
        retry: false,
        reason: "model deprecated; removing it from the chain",
      }

    case "auth":
      return {
        cooldownMs: 15 * 60 * 1000,
        resweep: true,
        // A failed key usually affects a whole provider, so the rotation
        // walks the rest of the chain; the mode itself is NOT changed — only
        // insufficient funds moves a mode (owner, 2026-10-12).
        degrade: false,
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

/** Short human description of an error kind, for logs and status. */
export function describeError(kind: ErrorKind): string {
  switch (kind) {
    case "interrupted": return "request interrupted"
    case "funds": return "insufficient funds"
    case "freequota": return "promotional free quota exhausted"
    case "rate": return "rate limited"
    case "context": return "context exceeded"
    case "capability": return "capability mismatch"
    case "notfound": return "model not found"
    case "deprecated": return "model deprecated"
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
