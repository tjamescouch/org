// src/runtime/hotkeys.ts
/**
 * Lightweight hotkey manager for raw TTY sessions.
 *
 * - Installs a single `keypress` listener (via readline.emitKeypressEvents)
 * - Puts stdin in raw mode while active; restores previous raw state on dispose
 * - ESC: triggers onEsc only when pressed *alone* (not as part of arrow/meta seq)
 * - Ctrl+C: triggers onCtrlC (default: exit 130)
 * - Interject key: single printable key (default "i")
 *
 * No-ops entirely when !process.stdin.isTTY (CI, pipes, --prompt "text", etc).
 */

import * as readline from "readline";
import { Logger } from "../logger";

type Handlers = {
  onEsc?: () => void;
  onInterject?: () => void;
  onCtrlC?: () => void;
};

type Options = {
  /** Which single key triggers interjection; case-insensitive. Default: "i". */
  interjectKey?: string;
  /** Debounce for lone ESC detection (ms). Default: 120. */
  escDelayMs?: number;
};

let installed = false;
let listener: ((str: string, key: readline.Key) => void) | null = null;
let prevRaw = false;
let active = true;
let pendingEsc: NodeJS.Timeout | null = null;

const noopDispose = () => ({ dispose() {} });

function isTTY() {
  return !!process.stdin.isTTY;
}

function setRawMode(enable: boolean) {
  const s: any = process.stdin as any;
  if (!isTTY()) return;
  if (typeof s.setRawMode === "function") {
    try {
      s.setRawMode(enable);
      (s as any).isRaw = !!enable; // keep a flag we can read back
    } catch { /* ignore */ }
  }
}

function clearPendingEsc() {
  if (pendingEsc) {
    clearTimeout(pendingEsc);
    pendingEsc = null;
  }
}

/**
 * Install hotkeys. Returns an object with a `dispose()` you *can* call,
 * but you can also call the exported `disposeHotkeys()` globally.
 */
export function installHotkeys(
  handlers: Handlers,
  opts: Options = {}
) {
  if (!isTTY()) {
    // Non-interactive environments: everything is a no-op.
    installed = false;
    listener = null;
    return noopDispose();
  }

  // If already installed, clean up first to be idempotent.
  if (installed) disposeHotkeys();

  const interjectKey = String(opts.interjectKey || "i").toLowerCase();
  const escDelayMs = Math.max(0, opts.escDelayMs ?? 120);

  readline.emitKeypressEvents(process.stdin);

  // Remember previous raw state and turn on raw while installed.
  const anyStdin: any = process.stdin as any;
  prevRaw = !!anyStdin?.isRaw;
  setRawMode(true);

  installed = true;

  listener = (str: string, key: readline.Key) => {
    if (!active) return;
    if (!key) return;

    // Ctrl+C — fast exit (default)
    if (key.ctrl && key.name === "c") {
      clearPendingEsc();
      if (handlers.onCtrlC) handlers.onCtrlC();
      else {
        try { setRawMode(false); } catch {}
        process.stdout.write("\n");
        process.exit(130);
      }
      return;
    }

    const name = (key.name || "").toLowerCase();

    // Arrow keys (and most special keys) should NEVER trigger ESC.
    // Node's keypress usually maps them to 'up','down','left','right', etc.
    // If we *do* see 'escape', make sure it's the lone '\u001b' sequence.
    const seq = (key as any).sequence as string | undefined;

    // Lone ESC handling: set a short timer; if anything else arrives,
    // we cancel. This avoids swallowing Meta/Alt combos and odd terms.
    if (name === "escape" && (!seq || seq === "\u001b")) {
      clearPendingEsc();
      pendingEsc = setTimeout(() => {
        pendingEsc = null;
        try { handlers.onEsc?.(); } catch (e) { Logger.error(e); }
      }, escDelayMs);
      return;
    }

    // Any other keypress cancels a pending ESC
    clearPendingEsc();

    // Interjection hotkey (single printable; ignore when ctrl/meta/shift used)
    if (!key.ctrl && !key.meta && name === interjectKey) {
      try { handlers.onInterject?.(); } catch (e) { Logger.error(e); }
      return;
    }

    // Everything else is ignored here — arrow keys included.
  };

  process.stdin.on("keypress", listener);

  // Best-effort raw restore on process death
  const restore = () => {
    try { disposeHotkeys(); } catch {}
  };
  process.once("exit", restore);
  process.once("SIGTERM", () => { restore(); process.exit(143); });
  process.once("uncaughtException", (err) => { try { disposeHotkeys(); } catch {}; Logger.error(err); });
  process.once("unhandledRejection", (reason: any) => { try { disposeHotkeys(); } catch {}; Logger.error(reason); });

  return { dispose: disposeHotkeys };
}

/** Remove key listener and restore original raw state. */
export function disposeHotkeys() {
  clearPendingEsc();
  if (!installed) return;
  if (listener) {
    try { process.stdin.removeListener("keypress", listener); } catch {}
  }
  listener = null;
  installed = false;

  // Restore raw state to what it was before installation.
  try { setRawMode(prevRaw); } catch {}
}

/** Temporarily stop dispatching hotkeys without uninstalling. */
export function disable() { active = false; }
/** Resume dispatching hotkeys. */
export function enable() { active = true; }
