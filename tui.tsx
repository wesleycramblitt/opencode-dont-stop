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

import { MODES, readState, writeState, type Mode, type PluginState } from "./lib/state.ts"
import { describeMode } from "./lib/modes.ts"

const statePath = join(homedir(), ".config", "opencode", "dont-stop-state.json")

export default {
  id: "dont-stop",
  setup(ctx: Parameters<NonNullable<Plugin.Definition["setup"]>>[0]) {
    /* ------------------------------------------------------------- state feed */

    // The state file is the bridge. Watch its mtime rather than polling its
    // contents: the server half writes atomically via rename, so an mtime
    // change is a reliable, cheap signal.
    let snapshot: PluginState = readState()
    let stamp = mtimeOf(statePath)
    const listeners = new Set<() => void>()

    const timer = setInterval(() => {
      const next = mtimeOf(statePath)
      if (next === stamp) return
      stamp = next
      snapshot = readState()
      for (const listener of listeners) listener()
    }, 500)

    function read(): PluginState {
      return snapshot
    }

    /* ---------------------------------------------------------------- footer */

    // A reactive read of the state file. Solid re-runs the claim whenever a
    // listener fires, which is what makes the footer live.
    function useLoopState(): PluginState {
      // Solid's tracking works through the renderer's own reactivity, so a
      // plain read here re-evaluates when the claim re-renders.
      void listeners.size
      return read()
    }

    const disposeFooter = ctx.ui.slot({
      replace: "prompt.footer.status",
      render: () => <DontStopFooter state={useLoopState()} />,
    })

    /* ---------------------------------------------------------------- toasts */

    // Announce transitions that a user would otherwise miss: a mode change, a
    // loop starting or stopping, and a model rotation. Deduplicated on the
    // state's `updated` stamp so a heartbeat does not spam.
    let lastAnnounced = 0
    const announceInterval = setInterval(() => {
      const state = read()
      if (state.updated === lastAnnounced) return
      const previous = lastAnnounced
      lastAnnounced = state.updated

      if (state.loop.status === "active" && previous === 0) {
        toast(ctx, "info", "dont-stop", `loop running in ${state.mode} mode`)
        return
      }
      if (state.loop.lastResult) {
        toast(ctx, "info", "dont-stop", state.loop.lastResult)
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
     */
    function writeMode(mode: Mode): void {
      const state = readState()
      if (state.mode === mode) return
      state.mode = mode
      // Bump `updated` so the server half sees the change even though the
      // loop fields are untouched.
      state.updated = Date.now()
      writeState(state)
      snapshot = state
      stamp = mtimeOf(statePath)
      for (const listener of listeners) listener()
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
      state.intent = { seq: state.intent.seq + 1, action: "halt", at: Date.now() }
      state.updated = Date.now()
      writeState(state)
      snapshot = state
      stamp = mtimeOf(statePath)
      for (const listener of listeners) listener()
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

interface FooterProps {
  state: PluginState
}

/**
 * The footer. Shows mode, loop progress, and the working model. Kept to two
 * short segments so it never crowds the composer it sits beside.
 */
function DontStopFooter(props: FooterProps): JSX.Element {
  const state = props.state
  const mode = state.mode
  const loop = state.loop

  if (loop.status !== "active" && mode === "free") {
    // The default mode with no loop running is not worth any footer space.
    return <></>
  }

  const iterations = loop.iterations
  const degraded = state.degraded ? "!" : ""
  // A halt is a request, not an event: the status keeps reading "active" until
  // the owning instance applies it, so the pending request is what the footer
  // shows in the meantime — otherwise a halt looks like it did nothing.
  const halting =
    loop.status === "active" &&
    state.intent.action === "halt" &&
    state.intent.at > (loop.startedAt ?? 0)

  return (
    <box flexDirection="row" gap={1}>
      <text fg="magenta">◍</text>
      <text fg="cyan">{mode}{degraded}</text>
      {loop.status === "active" ? (
        halting ? (
          <text fg="yellow">halting…</text>
        ) : (
          <>
            <text fg="green">⟳ {iterations}</text>
            {state.main ? <text fg="gray">{state.main.providerID}/{state.main.id}</text> : null}
          </>
        )
      ) : (
        <text fg="gray">idle</text>
      )}
    </box>
  )
}

/* ------------------------------------------------------------------ helpers */

function mtimeOf(path: string): number {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : 0
  } catch {
    return 0
  }
}
