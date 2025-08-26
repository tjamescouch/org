/**
 * Low-level, no-echo hotkeys helper for interactive TTY sessions.
 *
 * Features
 * - Keeps stdin in raw mode while enabled (restores the prior state on disable).
 * - Listens to keypress events without echo (readline.emitKeypressEvents).
 * - Ignores navigation sequences (arrows/home/end/page up/down, etc.).
 * - Debounced ESC so Alt/meta combos don't accidentally trigger onEsc.
 * - Handles Ctrl+C (fast abort) and a single-character interject key.
 *
 * Usage:
 *   const hk = new Hotkeys(
 *     { onEsc: finalize, onInterject: askUser, onCtrlC: hardAbort },
 *     { interjectKey: 'i', escDelayMs: 120, debug: false }
 *   );
 *   hk.enable();
 *   // ...
 *   hk.dispose();
 */
import * as readline from "readline";


export function disposeHotkeys(): void {
  try { singleton?.dispose(); } finally { singleton = null; }
}

export function enableHotkeys(): void { singleton?.enable(); }
export function disableHotkeys(): void { singleton?.disable(); }
export function isHotkeysInstalled(): boolean { return !!singleton; }


export type HotkeyHandlers = {
  /** Called on standalone ESC (after a short debounce window). */
  onEsc?: () => void | Promise<void>;
  /** Called when the interject key (default 'i') is pressed. */
  onInterject?: () => void | Promise<void>;
  /** Called on Ctrl+C (fast abort). */
  onCtrlC?: () => void | Promise<void>;
};

export type HotkeyOptions = {
  /** Single-letter hotkey to trigger interjection. Default: 'i'. */
  interjectKey?: string;
  /**
   * ESC debounce window (ms). If another key arrives during this window,
   * we treat the ESC as part of an Alt/meta sequence and cancel onEsc.
   * Default: 120ms.
   */
  escDelayMs?: number;
  /** Verbose logs of parsed key events. Default: false. */
  debug?: boolean;
};

const NAV_KEYS = new Set([
  "up", "down", "left", "right",
  "home", "end", "pageup", "pagedown",
  "insert", "delete", "tab"
]);

function isTTY(): boolean {
  return !!process.stdin.isTTY;
}

function currentRaw(): boolean {
  const any = process.stdin as any;
  return !!(any && typeof any.isRaw === "boolean" && any.isRaw);
}

function setRaw(value: boolean) {
  const any = process.stdin as any;
  if (!isTTY()) return;
  if (typeof any.setRawMode === "function") {
    try { any.setRawMode(value); } catch { /* non-tty/CI */ }
  }
}

export class Hotkeys {
  private handlers: HotkeyHandlers;
  private opts: Required<HotkeyOptions>;
  private enabled = false;

  private prevRaw = false;
  private bound?: (str: string, key: readline.Key) => void;

  private escTimer: NodeJS.Timeout | null = null;

  constructor(handlers: HotkeyHandlers, opts: HotkeyOptions = {}) {
    this.handlers = handlers || {};
    this.opts = {
      interjectKey: (opts.interjectKey ?? "i").toLowerCase(),
      escDelayMs: opts.escDelayMs ?? 120,
      debug: !!opts.debug,
    };
  }

  enable() {
    if (this.enabled) return;
    if (!isTTY()) return;

    // Prepare keypress events; put tty into raw if not already.
    readline.emitKeypressEvents(process.stdin);

    this.prevRaw = currentRaw();
    if (!this.prevRaw) setRaw(true);

    this.bound = this.onKeypress;
    process.stdin.on("keypress", this.bound);

    this.enabled = true;
  }

  disable() {
    if (!this.enabled) return;

    if (this.bound) {
      try { process.stdin.removeListener("keypress", this.bound); } catch { /* ignore */ }
      this.bound = undefined;
    }

    // Restore raw mode to what it was before enabling.
    if (!this.prevRaw) setRaw(false);

    // Clear any pending ESC debounce.
    if (this.escTimer) { clearTimeout(this.escTimer); this.escTimer = null; }

    this.enabled = false;
  }

  dispose() {
    this.disable();
  }

  // -------------------------------------------------------------------------

  private onKeypress = (str: string, key: readline.Key) => {
    if (!this.enabled || !key) return;

    if (this.opts.debug) {
      // eslint-disable-next-line no-console
      console.log("[hotkeys]", JSON.stringify({ str, key }));
    }

    // Ctrl+C — fast abort. Do NOT debounce.
    if (key.ctrl && key.name === "c") {
      void this.handlers.onCtrlC?.();
      return;
    }

    const name = (key.name || "").toLowerCase();

    // If an ESC-debounce is pending and we receive another key,
    // treat the ESC as part of an Alt/meta or arrow sequence; cancel it.
    if (this.escTimer && !(name === "escape")) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }

    // Ignore navigation and editing keys in raw-idle mode.
    if (NAV_KEYS.has(name)) return;

    // Standalone ESC: debounce briefly to avoid eating Alt/meta combos.
    if (name === "escape") {
      if (this.escTimer) clearTimeout(this.escTimer);
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        void this.handlers.onEsc?.();
      }, this.opts.escDelayMs);
      return;
    }

    // Interject hotkey: single letter, no ctrl/meta modifiers.
    if (!key.ctrl && !key.meta && name === this.opts.interjectKey) {
      void this.handlers.onInterject?.();
      return;
    }

    // Anything else: do nothing in idle/raw mode.
  };
}

let singleton: Hotkeys | null = null;

export function installHotkeys(
  handlers: HotkeyHandlers,
  opts: HotkeyOptions = {}
): Hotkeys {
  if (singleton) return singleton;
  singleton = new Hotkeys(handlers, opts);
  singleton.enable();
  return singleton;
}
export default Hotkeys;
