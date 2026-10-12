/**
 * dont-stop — terminal entrypoint.
 *
 * Renders the loop's live status into the prompt footer and surfaces
 * meaningful transitions as toasts. This half owns no logic: it reads the
 * durable state the server half writes, so the two never race and either can
 * restart without losing the other's view.
 *
 * The footer claim targets `prompt.footer.status`, which is the one slot the
 * host publishes for exactly this. Rendering is reactive off the state file's
 * mtime, so a change made headlessly shows up in the next terminal too.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"

import { MODES, dontStopDisabled, readState, writeState, type LoopState, type Mode, type PluginState } from "./lib/state.ts"
import { describeMode } from "./lib/modes.ts"

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
        replace: "prompt.footer.status",
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

    // The state file is the bridge. Watch its mtime rather than polling its
    // contents: the server half writes atomically via rename, so an mtime
    // change is a reliable, cheap signal. The signal reaches the footer
    // through a Solid `createSignal` (the slot render mounts it; the timer
    // pushes into it), so the footer re-renders on every actual change —
    // including a mode change while nothing else moves, which the old
    // non-reactive read missed.
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

    // The footer shows the loop of the session the prompt belongs to when
    // that session has one — per-session since 2026-10-12 — and falls back to
    // the newest loop otherwise, so the plugin's state is never a mystery.
    const disposeFooter = ctx.ui.slot({
      replace: "prompt.footer.status",
      render: (props: { sessionID?: string }) => {
        const [snap, setSnap] = createSignal<PluginState>(read())
        const version = ++slotVersion
        push = (state) => {
          if (version === slotVersion) setSnap(state)
        }
        onCleanup(() => {
          if (version === slotVersion) push = null
        })
        return <DontStopFooter state={snap()} sessionID={props.sessionID ?? null} />
      },
    })

    /* ---------------------------------------------------------------- toasts */

    // Announce transitions that a user would otherwise miss: a mode change, a
    // loop starting or stopping, and a model rotation. Deduplicated twice —
    // on the `updated` stamp so a heartbeat does not spam, and on the message
    // itself so a stale result cannot re-toast on every unrelated write.
    let lastAnnounced = 0
    let lastMessage = ""
    const announceInterval = setInterval(() => {
      const state = read()
      if (state.updated === lastAnnounced) return
      const previous = lastAnnounced
      lastAnnounced = state.updated

      const primary = Object.values(state.loops).find((l) => l.status === "active")
      if (primary && previous === 0) {
        toast(ctx, "info", "dont-stop", `loop running in ${primary.mode} mode`)
        return
      }
      const loop = primary ?? Object.values(state.loops)[0]
      const message = loop?.lastResult
      if (previous === 0) {
        // First look at a settled state: this terminal never saw the stop
        // that produced the last result, so announcing it would toast
        // "plugin unloaded" on every session start. Record it and wait for
        // a real transition.
        if (message) lastMessage = message
        return
      }
      if (message && message !== lastMessage) {
        lastMessage = message
        toast(ctx, "info", "dont-stop", message)
      }
    }, 1000)

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

    // Cycle modes with a keybinding. The order follows the cost ranking in
    // lib/modes.ts so repeated presses walk free -> cheap -> local -> power.
    const modeOrder: Mode[] = MODES.filter((m) => m !== "stop") as Mode[]

    /**
     * Register the keymap layer.
     *
     * `keymap.layer` reads the keymap through a reactive context, so it can
     * only be called from inside the component tree — calling it from `setup`
     * fails with "Keymap.Provider is missing", because the provider the read
     * resolves against has not been established yet. An `app` slot renders
     * inside that tree, so registration is deferred to its render function and
     * torn down with the slot.
     */
    const commands = [
      {
        id: "dont-stop.status",
        title: "dont-stop: show status",
        description: "Report mode, loop state, iterations and model",
        group: "dont-stop",
        suggested: true,
        run: () => {
          const s = read()
          toast(ctx, "info", "dont-stop", statusLine(s))
        },
      },
      {
        id: "dont-stop.cycle-mode",
        title: "dont-stop: cycle mode",
        description: "Cycle free, cheap, local, power",
        group: "dont-stop",
        suggested: true,
        slash: { name: "dont-stop-toggle", arguments: true },
        run: () => {
          const state = read()
          const index = modeOrder.indexOf(state.mode)
          const next = modeOrder[(index + 1) % modeOrder.length]
          writeMode(next)
          toast(ctx, "info", "dont-stop", `mode: ${next} — ${describeMode(next)}`)
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
        // Dispose the previous layer before registering the next one. The app
        // slot can re-render (a state-file churn re-renders the tree it sits
        // in), and a render that registered a fresh layer on top of the old
        // one left both live — every re-render added a duplicate "dont-stop"
        // command to the palette, which is the "Session/System sections
        // cycling" symptom: the palette wasn't refreshing, it was growing.
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
     * Write a mode request into the state file. The server half reconciles
     * this on its next watch tick, which is the one direction the terminal is
     * allowed to drive.
     *
     * A mode change is a control intent, not a status field: the engine that
     * owns the loop rewrites the whole file on its beats, and a plain
     * `state.mode` write was reverted by the next beat of any instance whose
     * memory still said the old mode — "I set cheap and it stayed free". The
     * sequential intent survives every status write and every instance
     * applies it to its own memory before persisting again.
     */
    function writeMode(mode: Mode): void {
      const state = readState()
      if (state.mode === mode) return
      const theirs = readState().intent
      state.intent = {
        seq: Math.max(theirs.seq, state.intent.seq) + 1,
        action: "mode",
        mode,
        at: Date.now(),
      }
      state.mode = mode
      // Bump `updated` so the server half sees the change even though the
      // loop fields are untouched.
      state.updated = Date.now()
      writeState(state)
      snapshot = state
      stamp = mtimeOf(statePath)
      push?.(snapshot)
    }

    /**
     * Ask the loop to stop.
     *
     * The terminal does not own the loop's status: the engine reports it and
     * rewrites the whole file on every heartbeat, so writing `loop.status`
     * directly was a request that could be — and was — overwritten before it
     * was read. An intent is the opposite shape. It carries a sequence number,
     * every writer merges intents by that number instead of last-write-wins,
     * and the engine applies a halt it has not already acted on. The request
     * therefore outlives the race that used to swallow it.
     */
    function requestHalt(): void {
      const state = readState()
      // Raise the sequence above any intent another writer has in flight, so
      // two halts racing from the same base cannot stamp the same number and
      // let one of them be read as already-applied.
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
      // The layer is torn down with the slot that registered it, so unregister
      // that too rather than calling a disposer that may never have run.
      disposeKeymap?.()
      if (typeof disposeKeymapSlot === "function") disposeKeymapSlot()
      disposeFooter()
    }
  },
}

/* ------------------------------------------------------------------- render */

/**
 * The footer. Always visible, so the loop's state is never a mystery. Shows
 * the loop of the CURRENT session when it has one (per-session, 2026-10-12),
 * else the newest loop anywhere: mode, iterations while running, a pending
 * halt, the model, and the cooling count. Kept to two short segments so it
 * never crowds the composer it sits beside.
 */
function DontStopFooter(props: { state: PluginState; sessionID: string | null }): JSX.Element {
  const state = props.state
  const loop = loopForFooter(state, props.sessionID)
  const active = loop?.status === "active"

  // The mode shown is the loop's own while it runs; otherwise the default
  // mode, which is what mode changes actually move. A stopped loop's stale
  // mode must not hide the new default from the footer.
  const mode = active ? loop!.mode : state.mode

  const degraded = !active ? false : loop!.degraded === true
  // A halt is a request, not an event: the status keeps reading "active" until
  // the owning instance applies it, so the pending request is what the footer
  // shows in the meantime — otherwise a halt looks like it did nothing.
  const halting =
    active &&
    state.intent.action === "halt" &&
    state.intent.at > (loop!.startedAt ?? 0)

  return (
    <box flexDirection="row" gap={1}>
      <text fg="magenta">◍</text>
      <text fg="cyan">{mode}{degraded ? "!" : ""}</text>
      {active ? (
        halting ? (
          <text fg="yellow">halting…</text>
        ) : (
          <>
            <text fg="green">⟳ {loop!.iterations}</text>
            <text fg="gray">s{loop!.sessionIterations}</text>
            {state.main ? <text fg="gray">{state.main.providerID}/{state.main.id}</text> : null}
            {loop!.turnStartedAt ? <text fg="brightBlack">working</text> : null}
          </>
        )
      ) : (
        <text fg="gray">idle</text>
      )}
      {state.cooldowns && Object.keys(state.cooldowns).length > 0 ? (
        <text fg="yellow">cooling {Object.keys(state.cooldowns).length}</text>
      ) : null}
    </box>
  )
}

/** Which loop a footer shows: the current session's, else the newest. */
function loopForFooter(state: PluginState, sessionID: string | null): LoopState | null {
  if (sessionID && state.loops[sessionID]) return state.loops[sessionID]
  const loops = Object.values(state.loops)
  if (loops.length === 0) return null
  const active = loops.filter((l) => l.status === "active")
  const pool = active.length > 0 ? active : loops
  return [...pool].sort(
    (a, b) => (b.ownerBeatAt || b.startedAt || 0) - (a.ownerBeatAt || a.startedAt || 0),
  )[0]
}

/** One line per loop, for the palette command and status toasts. */
function statusLine(state: PluginState): string {
  const loops = Object.values(state.loops)
  const parts = [`default mode ${state.mode}`]
  if (loops.length === 0) {
    parts.push("no loops")
  } else {
    for (const loop of loops) {
      const where = loop.sessionID ? loop.sessionID.slice(0, 12) : "?"
      parts.push(
        `${where} ${loop.status}${loop.iterations > 0 ? ` ${loop.iterations}it` : ""} ` +
          `${loop.mode}${loop.degraded ? "!" : ""}`,
      )
    }
  }
  const cooling = Object.keys(state.cooldowns).length
  if (cooling > 0) parts.push(`${cooling} model${cooling === 1 ? "" : "s"} cooling`)
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
