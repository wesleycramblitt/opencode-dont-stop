/**
 * dont-stop — OpenCode V2 event vocabulary.
 *
 * The engine is event-driven, so the vocabulary it listens to has to match the
 * server that publishes it. OpenCode v2 streams events as
 * `{ id, created, type, data }` — the payload lives under `data`, not the V1
 * `properties` — and the event names are `session.execution.*`,
 * `session.step.*`, `session.text.*`, `session.tool.*`, and so on. There is no
 * `message.*` family and no V1-style lifecycle names.
 *
 * This module is the single place that knows that vocabulary. The engine and
 * the server entrypoint ask one question — "what does this event mean?" — and
 * get back a plain structure: which session it concerns, whether a turn
 * started or finished, whether the session made progress, and any error it
 * carried. Nothing else in the plugin matches event names.
 *
 * The mapping is a table, not a regex: every name the server emits is listed
 * explicitly, so an event that is not handled is visible in a diff rather than
 * silently swallowed by a pattern.
 */

import type { ProgressKind } from "./clocks.ts"

/** A raw event as the server streams it (plus the legacy `properties` shape). */
export interface SessionEvent {
  type: string
  data?: Record<string, unknown>
  properties?: Record<string, unknown>
}

/** A model reference as the server reports it. */
export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

/** A provider-reported failure, tolerantly extracted. */
export interface EventError {
  message?: string
  status?: number
  type?: string
}

/** What the engine needs to know about one event. */
export interface EventSignals {
  sessionID: string | null
  /** Whether a request began or ended on the session. */
  lifecycle: "start" | "finish" | null
  /** Which kind of progress this event proves, when any. */
  progress: ProgressKind | null
  /** Agent name, when the event names one. */
  agent: string | null
  /** The model in use, when the event names one. */
  model: ModelRef | null
  /** A failure, when the event carries one. */
  error: EventError | null
}

/** The payload of an event: `data` on v2, tolerated `properties` fallback. */
export function eventData(event: SessionEvent): Record<string, unknown> {
  const data = event.data
  if (data && typeof data === "object") return data as Record<string, unknown>
  const properties = event.properties
  if (properties && typeof properties === "object") return properties as Record<string, unknown>
  return {}
}

const TURN_START_EVENTS = new Set(["session.execution.started"])
const TURN_END_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.error",
])

/**
 * Decode an event into engine signals.
 *
 * Ordering rules, deliberately simple:
 *
 * - A turn *finish* wins over progress: an error event is both the end of a
 *   turn and the signal that it failed, and the engine needs the ending more
 *   than the activity.
 * - An error is only attached to events that actually carry one
 *   (`session.error`, `session.execution.failed`). A successful finish carries
 *   no error.
 * - `session.status` is mapped through its `status` field: `busy` starts a
 *   turn, anything else ends it.
 */
export function eventSignals(event: SessionEvent): EventSignals {
  const type = event.type
  const data = eventData(event)
  const sessionID = stringOf(data.sessionID) ?? null

  let lifecycle: EventSignals["lifecycle"] = null
  let progress: ProgressKind | null = null
  let agent: string | null = typeof data.agent === "string" ? data.agent : null
  let model: ModelRef | null = modelOf(data.model)
  let error: EventError | null = null

  if (TURN_END_EVENTS.has(type)) {
    lifecycle = "finish"
    if (type === "session.error" || type === "session.execution.failed") {
      error = errorOf(data.error)
    }
  } else if (TURN_START_EVENTS.has(type)) {
    lifecycle = "start"
    progress = "step"
  } else if (type === "session.status") {
    lifecycle = String(data.status) === "busy" ? "start" : "finish"
  } else {
    switch (type) {
      case "session.step.started": {
        // Carries the agent and model for the turn, which the engine wants on
        // every turn even when the session was created elsewhere.
        progress = "step"
        agent = typeof data.agent === "string" ? data.agent : agent
        model = modelOf(data.model) ?? model
        break
      }
      case "session.step.streamed":
      case "session.step.ended":
        progress = "step"
        break
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
        progress = "token"
        break
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended":
        progress = "reasoning"
        break
      case "session.tool.called":
      case "session.tool.success":
      case "session.tool.failed":
      case "session.tool.progress":
      case "session.tool.input.started":
      case "session.tool.input.delta":
      case "session.tool.input.ended":
        progress = "tool"
        break
      case "permission.asked":
      case "permission.replied":
        progress = "permission"
        break
      case "session.usage.updated":
      case "session.usage.recorded":
      case "session.compacted":
      case "session.compaction.started":
      case "session.compaction.ended":
        progress = "step"
        break
      case "session.retry.scheduled":
        // A retry is the absence of progress, not a sign of it: the provider
        // failed and the client is backing off. Counting it as progress would
        // keep the hang clock disarmed while a session burns through retries
        // on a model that is not answering — the "upstream request failed"
        // storm where the model is never timed out. It still counts as
        // *seen*, so the idle clock does not stand the session down. The
        // event carries the error that caused the retry, which the engine
        // uses to cut the storm short instead.
        error = errorOf(data.error)
        break
      case "session.inbox.delivered":
        progress = "message"
        break
      case "session.created":
      case "session.updated":
        // Session metadata: the pinned model and agent, for tracking.
        model = modelOf(data.model) ?? model
        if (typeof data.agent === "string") agent = data.agent
        break
      case "session.model.selected": {
        const info = data.info
        const fromInfo = info && typeof info === "object"
          ? modelOf((info as Record<string, unknown>).model)
          : null
        model = modelOf(data.model) ?? fromInfo ?? model
        break
      }
      case "session.agent.selected": {
        const agentName = stringOf(data.agent)
        if (agentName !== undefined) agent = agentName
        break
      }
    }
  }

  return { sessionID, lifecycle, progress, agent, model, error }
}

/* ------------------------------------------------------------------ helpers */

/**
 * The events that end a turn: the `session.execution.*` trio. v2 emits
 * exactly one of these per turn, which is what makes them safe as the loop's
 * driver — idle and status events trail an execution result and would
 * double-advance it.
 */
export const TURN_END_TYPES: ReadonlySet<string> = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

/** A model ref out of anything that might be one, or null. */
function modelOf(value: unknown): ModelRef | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const providerID = stringOf(record.providerID)
  const id = stringOf(record.id)
  if (!providerID || !id) return null
  const variant = stringOf(record.variant)
  return variant ? { providerID, id, variant } : { providerID, id }
}

/**
 * An error out of anything the server might report.
 *
 * The server sends errors in a few shapes — `{ message, status, type }`,
 * `{ name, data: { ... } }` (AI SDK style) — and the classifier downstream only
 * needs message, status and type, so the extraction is tolerant and shallow.
 */
function errorOf(value: unknown): EventError | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const message = stringOf(record.message) ?? nestedMessage(record)
  const status = numberOf(record.status) ?? numberOf(record.statusCode)
  const type = stringOf(record.type) ?? stringOf(record.name)
  if (message === undefined && status === undefined && type === undefined) return null
  return { message, status, type }
}

/** A message nested under `data` or `error`, e.g. AI SDK `{ name, data: {...} }`. */
function nestedMessage(record: Record<string, unknown>): string | undefined {
  const nested = record.data ?? record.error
  if (!nested || typeof nested !== "object") return undefined
  return stringOf((nested as Record<string, unknown>).message)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}