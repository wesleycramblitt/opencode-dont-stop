/**
 * dont-stop — terminal entrypoint.
 *
 * Renders the loop's live status into the prompt footer and surfaces
 * meaningful transitions as toasts. This half owns no logic: it reads the
 * durable state the server half writes, so the two never race and either can
 * restart without losing the other's view.
 *
 * The footer claim targets `prompt.footer.status`, appended rather than
 * replaced: the host publishes that slot for status contributions. Rendering
 * is reactive off the state file's mtime, so a change made headlessly shows up
 * in the next terminal too.
 *
 * Model selection, modes, ranking — all owned exclusively by the sibling
 * model-selector plugin. This TUI only shows loop status: iterations, session turns, active
 * state.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"

import { dontStopDisabled, readState, writeState, type LoopState, type PluginState } from "./lib/state.ts"

const statePath = join(homedir(), ".config", "opencode", "dont-stop-state.json")

export default {
  id: "dont-stop",
  setup(ctx: Parameters<NonNullable<Plugin.Definition["setup"]>>[0]) {
    /* ------------------------------------------------------- disabled gate */

    // The hard switch, honored with no restart: an inert footer that says the
    // plugin is off, and no command surface. Removing the plugin from
    // `plugins` in opencode.json requires restarting the service; the env var
    // does not.
    if (dontStopDisabled()) {
      const disposeFooter = ctx.ui.slot({
        append: "prompt.footer.status",
        render: () => (
          <box flexDirection="row" gap={1}>
            <text fg="gray">◍ dont-stop off</text>
          </box>
        ),
      })
      return () => {
        disposeFooter()
      }
    }

    /* ------------------------------------------------------------- state feed */

    let snapshot: PluginState = readState()
    let stamp = mtimeOf(statePath)
    let push: ((state: PluginState) => void) | null = null
    let slotVersion = 0

    const timer = setInterval(() => {
      const next = mtimeOf(statePath)
      if (next === stamp) return
      stamp = next
      snapshot = readState()
      push?.(snapshot)
    }, 500)

    function read(): PluginState {
      return snapshot
    }

    /* ---------------------------------------------------------------- footer */

    const disposeFooter = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (props: { sessionID?: string }) => {
        if (props.sessionID !== currentSessionID) {
          watchingLoop = false
          sawLoopHere = false
        }
        currentSessionID = props.sessionID ?? null
        const [snap, setSnap] = createSignal<PluginState>(read())
        const version = ++slotVersion
        push = (state) => {
          if (version === slotVersion) setSnap(state)
        }
        onCleanup(() => {
          if (version === slotVersion) push = null
        })
        // Pass the accessor so the footer re-renders on every 500ms poll push.
        return <DontStopFooter state={snap} sessionID={props.sessionID ?? null} />
      },
    })

    /* ---------------------------------------------------------------- toasts */

    // Announce transitions that a user would otherwise miss: a loop starting,
    // stopping, or rotating. Deduplicated twice — on the `updated` stamp so a
    // heartbeat does not spam, and on the message itself.
    let lastAnnounced = 0
    let lastMessage = ""
    let currentSessionID: string | null = null
    let watchingLoop = false
    let sawLoopHere = false
    const announceInterval = setInterval(() => {
      const state = read()
      if (state.updated === lastAnnounced) return
      const previous = lastAnnounced
      lastAnnounced = state.updated

      const loops = Object.values(state.loops)
      const primary = [...loops.filter((l) => l.status === "active")].sort(
        (a, b) => (b.ownerBeatAt || b.startedAt || 0) - (a.ownerBeatAt || a.startedAt || 0),
      )[0]
      const here = currentSessionID ? state.loops[currentSessionID] : undefined
      const hereActive = here?.status === "active"

      // Follow a rotation: we were watching an active loop on this session,
      // and now it is stopped/retired but a different active loop exists.
      // The old row is kept as `stopped` (not deleted), so we trigger on
      // `hereActive` going false, not on `here` becoming undefined. Parse
      // the successor from lastResult when present, otherwise fall back to
      // the newest primary.
      // No rotation in single-session mode: the loop stays on its session.
      if (hereActive) {
        sawLoopHere = true
      }
      watchingLoop = hereActive

      if (hereActive && previous === 0) {
        toast(ctx, "info", "dont-stop", `loop running`)
        return
      }
      const loop = hereActive ? here : undefined
      const message = loop?.lastResult
      if (previous === 0) {
        if (message) lastMessage = message
        return
      }
      if (message && message !== lastMessage) {
        lastMessage = message
        toast(ctx, "info", "dont-stop", message)
      }
    }, 1000)

    /** Move this terminal's view to the session the loop now lives on. */
    function followSession(sessionID: string): void {
      try {
        const ui = ctx.ui as {
          tabs?: { enabled(): boolean; focus(sessionID: string): void }
          router?: { navigate(input: { type: "session"; sessionID: string }): void }
        }
        if (ui.tabs?.enabled()) ui.tabs.focus(sessionID)
        else ui.router?.navigate({ type: "session", sessionID })
      } catch {
        // No terminal attached; the toast and the state file still say where.
      }
    }

    function toast(
      target: Parameters<NonNullable<Plugin.Definition["setup"]>>[0],
      variant: "info" | "success" | "warning" | "error",
      title: string,
      message: string,
    ): void {
      try {
        target.ui.toast.show({ variant, title, message, duration: 6000 })
      } catch {
        // No terminal attached; the state file remains the source of truth.
      }
    }

    /* ----------------------------------------------------------------- keymap */

    const commands = [
      {
        id: "dont-stop.status",
        title: "dont-stop: show status",
        description: "Report loop state, iterations and intent",
        group: "dont-stop",
        suggested: true,
        run: () => {
          const s = read()
          toast(ctx, "info", "dont-stop", statusLine(s))
        },
      },
      {
        id: "dont-stop.stop-loop",
        title: "dont-stop: stop loop",
        description: "Stop the running loop",
        group: "dont-stop",
        slash: { name: "dont-stop-halt", arguments: true },
        run: () => {
          requestHalt()
          toast(ctx, "warning", "dont-stop", "halt requested")
        },
      },
    ]

    let disposeKeymap: (() => void) | undefined
    const disposeKeymapSlot = ctx.ui.slot({
      append: "app",
      render: () => {
        disposeKeymap?.()
        disposeKeymap = ctx.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands,
          bindings: [],
        }))
        return null
      },
    })

    /**
     * Write a halt intent into the state file. The server half reconciles
     * this on its next watch tick.
     */
    function requestHalt(): void {
      const state = readState()
      const theirs = readState().intent
      state.intent = {
        seq: Math.max(theirs.seq, state.intent.seq) + 1,
        action: "halt",
        at: Date.now(),
      }
      state.updated = Date.now()
      writeState(state)
      snapshot = state
      stamp = mtimeOf(statePath)
      push?.(snapshot)
    }

    return () => {
      clearInterval(timer)
      clearInterval(announceInterval)
      disposeKeymap?.()
      if (typeof disposeKeymapSlot === "function") disposeKeymapSlot()
      disposeFooter()
    }
  },
}

/* ------------------------------------------------------------------- render */

/**
 * The footer. Always visible. Shows the loop of the CURRENT session when it
 * has one, else idle. Loop status only: iterations while running, pending halt.
 */
function DontStopFooter(props: { state: () => PluginState; sessionID: string | null }): JSX.Element {
  return (
    <box flexDirection="row" gap={1}>
      <text fg="magenta">◍</text>
      {(() => {
        const state = props.state()
        const loop = loopForFooter(state, props.sessionID)
        const active = loop?.status === "active"
        // A halt is shown as "halting…" only while it is fresh. If the
        // engine fails to act (service restart dropped the intent, write
        // merge reverted it, etc.) the footer would otherwise be stuck on
        // "halting…" forever for an active loop. After a grace window we
        // fall back to the normal active rendering so the UI stays usable
        // and the next halt can be retried.
        const pendingHalt =
          active &&
          state.intent.action === "halt" &&
          state.intent.at > (loop!.startedAt ?? 0)
        const halting = pendingHalt && Date.now() - state.intent.at < 90_000
        if (!active) {
          return <text fg="gray">idle</text>
        }
        if (halting) return <text fg="yellow">halting…</text>
        return (
          <>
            <text fg="green">⟳ {loop!.iterations}</text>
            <text fg="gray">s{loop!.sessionIterations}</text>
            {loop!.turnStartedAt ? <text fg="brightBlack">working</text> : null}
          </>
        )
      })()}
    </box>
  )
}

/** Which loop a footer shows: the current session's, else idle (null). */
function loopForFooter(state: PluginState, sessionID: string | null): LoopState | null {
  if (sessionID && state.loops[sessionID]) return state.loops[sessionID]
  return null
}

/** One line per loop, for the palette command and status toasts. */
function statusLine(state: PluginState): string {
  const loops = Object.values(state.loops)
  const parts = [`dont-stop`]
  if (loops.length === 0) {
    parts.push("no loops")
  } else {
    for (const loop of loops) {
      const where = loop.sessionID ? loop.sessionID.slice(0, 12) : "?"
      parts.push(
        `${where} ${loop.status}${loop.iterations > 0 ? ` ${loop.iterations}it` : ""}`,
      )
    }
  }
  return parts.join(" · ")
}

/* ------------------------------------------------------------------ helpers */

function mtimeOf(path: string): number {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : 0
  } catch {
    return 0
  }
}
