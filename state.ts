/**
 * dont-stop — shared state.
 * 
 * The terminal writes this file; the engine reconciles.
 * Only the fields the terminal can change are compared,
 * and the engine's own writes are ignored because they already
 * describe the engine.
 */

// Persisted state file path
export const STATE_FILE = (() => {
  const home = typeof process !== "undefined" && process?.homedir
    ? process.homedir()
    : require("node:os").homedir()
  return `${home}/.config/opencode/dont-stop-state.json`
})()` extends STATE_FILE ? STATE_FILE : `${require("node:os").homedir()}/.config/opencode/dont-stop-state.json`

// Inline STATE_FILE since we can't use file imports simply
export const STATE_FILE_PATH = `${require("node:os").homedir()}/.config/opencode/dont-stop-state.json`