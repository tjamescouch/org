// src/runtime/hotkeys.ts
import * as readline from "readline";

export type KeyLike = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
};

type HotkeyOpts = {
  interjectKey: string;         // e.g. "i"
  onInterject: () => void;      // called when interject key is pressed
  onEsc: () => void;            // called on ESC
  onCtrlC: () => void;          // called on Ctrl+C
};

let currentOpts: HotkeyOpts | null = null;
let keyListener: ((str: string, key: readline.Key) => void) | null = null;
let enabled = false;

/** Install raw-mode key handling and route keys to the provided callbacks. */
export function registerHotkeys(opts: HotkeyOpts) {
  disposeHotkeys();
  currentOpts = opts;

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    try { (process.stdin as any).setRawMode?.(true); } catch { /* ignore */ }
  }

  keyListener = (_str: string, key: readline.Key) => {
    if (!enabled || !key) return;

    const name = (key.name || "").toLowerCase();

    if (key.ctrl && name === "c") {
      currentOpts?.onCtrlC();
      return;
    }

    if (name === "escape" || name === "esc") {
      currentOpts?.onEsc();
      return;
    }

    if (name === currentOpts?.interjectKey) {
      currentOpts?.onInterject();
      return;
    }
  };

  enabled = true;
  process.stdin.on("keypress", keyListener);
}

/** Remove listeners (leaves raw/cooked state as-is). */
export function disposeHotkeys() {
  enabled = false;
  if (keyListener) {
    try { process.stdin.removeListener("keypress", keyListener); } catch { /* ignore */ }
    keyListener = null;
  }
  currentOpts = null;
}

/** Temporarily gate hotkey processing (use during readline). */
export function setHotkeysEnabled(v: boolean) {
  enabled = !!v;
}
export function areHotkeysEnabled() { return enabled; }

/** Switch terminal between canonical editing (true) and raw (false). */
export function setCanonicalMode(enable: boolean) {
  if (!process.stdin.isTTY) return;
  try { (process.stdin as any).setRawMode?.(!enable); } catch { /* ignore */ }
}

/** Test helper: pretend the user pressed a key. */
export function injectKeyForTests(k: KeyLike) {
  if (!currentOpts) return;
  const name = (k.name || "").toLowerCase();

  if (k.ctrl && name === "c") { currentOpts.onCtrlC(); return; }
  if (name === "escape" || name === "esc") { currentOpts.onEsc(); return; }
  if (name === currentOpts.interjectKey) { currentOpts.onInterject(); return; }
}

/* ------------------------------------------------------------------------- */
/* Back-compat aliases (older code/tests may import these names)             */
/* ------------------------------------------------------------------------- */
export const installHotkeys = registerHotkeys;
export const uninstallHotkeys = disposeHotkeys;
export function enableHotkeys() { setHotkeysEnabled(true); }
export function disableHotkeys() { setHotkeysEnabled(false); }

/** Optional convenience default export (not required) */
export default {
  registerHotkeys,
  disposeHotkeys,
  setHotkeysEnabled,
  areHotkeysEnabled,
  setCanonicalMode,
  injectKeyForTests,
  // aliases
  installHotkeys,
  uninstallHotkeys,
  enableHotkeys,
  disableHotkeys,
};
