/**
 * Centralized low-level hotkey manager for org.
 *
 * Responsibilities:
 * - Attach exactly one key listener (keypress + raw "data" fallback).
 * - Distinguish real ESC from arrow-key escape sequences (debounced).
 * - Offer suspend()/resume() so readline can own the tty while prompting.
 * - Work when stdin is a TTY; degrade gracefully otherwise.
 *
 * Public API (stable):
 *   installHotkeys(opts)    // attach listeners (idempotent)
 *   disposeHotkeys()        // detach listeners
 *   updateHotkeys(opts)     // change interject key / allowInterject
 *   suspendHotkeys()        // temporarily ignore keys
 *   resumeHotkeys()         // re-enable keys
 *
 * Test helpers:
 *   __testOnly_emit(k)      // inject a synthetic key event (unit tests)
 */

import * as readline from "readline";

export type HotkeyHandlers = {
  onEsc?: () => void;
  onCtrlC?: () => void;
  onInterject?: () => void;
};

export type HotkeyConfig = {
  /** single-letter hotkey to interject; default 'i' */
  interjectKey?: string;
  /** when false, 'i' is ignored; ESC/Ctrl-C still work */
  allowInterject?: boolean;
};

type State = HotkeyHandlers & Required<HotkeyConfig> & {
  installed: boolean;
  enabled: boolean;     // global on/off (suspend/resume)
  listeningKeypress: boolean;
  listeningData: boolean;
  // debounce: allow ESC as a standalone key, but ignore arrow sequences '\x1B['
  escTimer: NodeJS.Timeout | null;
};

const S: State = {
  onEsc: undefined,
  onCtrlC: undefined,
  onInterject: undefined,

  interjectKey: "i",
  allowInterject: true,

  installed: false,
  enabled: true,
  listeningKeypress: false,
  listeningData: false,

  escTimer: null,
};

// ---- utilities --------------------------------------------------------------

function lower(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

function clearEscTimer() {
  if (S.escTimer) { clearTimeout(S.escTimer); S.escTimer = null; }
}

// ---- handlers ---------------------------------------------------------------

function handleKeypress(_str: string, key: readline.Key) {
  if (!S.enabled) return;
  if (!key) return;

  // Fast path: Ctrl+C (do not debounce)
  if (key.ctrl && lower(key.name) === "c") {
    S.onCtrlC?.();
    return;
  }

  const name = lower(key.name);

  // Raw ESC arrives as name === 'escape' in keypress events.
  // Arrow keys arrive as: name === 'up'|'down'|'left'|'right' — do nothing.
  if (name === "escape") {
    // tiny debounce to give "data" fallback a chance to detect arrow sequences.
    clearEscTimer();
    S.escTimer = setTimeout(() => {
      S.onEsc?.();
      S.escTimer = null;
    }, 25);
    return;
  }

  // Interject hotkey (single letter)
  if (S.allowInterject && name === lower(S.interjectKey)) {
    S.onInterject?.();
    return;
  }
}

/**
 * Raw "data" fallback for runtimes where 'keypress' is unreliable.
 * - '\x03'     -> Ctrl+C
 * - '\x1B'     -> ESC candidate (debounced)
 * - '\x1B['... -> Arrow / CSI sequences (cancel ESC)
 */
function handleDataChunk(buf: Buffer) {
  if (!S.enabled || !buf || buf.length === 0) return;

  const s = buf.toString("utf8");

  // Ctrl-C
  if (s === "\x03") {
    S.onCtrlC?.();
    return;
  }

  // Arrow sequences begin with ESC + '['. If we see that, cancel a pending ESC.
  if (s.startsWith("\x1B[")) {
    clearEscTimer();
    return; // ignore arrows / CSI
  }

  // Standalone ESC (single byte) — debounce already started by keypress or we start it here.
  if (s === "\x1B") {
    clearEscTimer();
    S.escTimer = setTimeout(() => {
      S.onEsc?.();
      S.escTimer = null;
    }, 25);
    return;
  }

  // Interject fallback if runtime only delivers plain chars
  if (S.allowInterject && lower(s) === lower(S.interjectKey)) {
    S.onInterject?.();
  }
}

// ---- public API -------------------------------------------------------------

export function installHotkeys(
  handlers: HotkeyHandlers,
  cfg?: HotkeyConfig
): void {
  if (S.installed) {
    updateHotkeys(cfg);
    // refresh handlers too
    S.onEsc = handlers.onEsc;
    S.onCtrlC = handlers.onCtrlC;
    S.onInterject = handlers.onInterject;
    return;
  }

  S.onEsc = handlers.onEsc;
  S.onCtrlC = handlers.onCtrlC;
  S.onInterject = handlers.onInterject;

  if (cfg) {
    if (cfg.interjectKey) S.interjectKey = cfg.interjectKey;
    if (typeof cfg.allowInterject === "boolean") S.allowInterject = cfg.allowInterject;
  }

  // Only attempt to wire TTY
  if (process.stdin.isTTY) {
    try {
      // Ensure keypress events are emitted; a dummy interface is fine here.
      readline.emitKeypressEvents(process.stdin as any);
      (process.stdin as any).setRawMode?.(true);
    } catch { /* non-tty or runtimes without setRawMode */ }
  }

  if (!S.listeningKeypress) {
    process.stdin.on("keypress", handleKeypress);
    S.listeningKeypress = true;
  }
  if (!S.listeningData) {
    process.stdin.on("data", handleDataChunk);
    S.listeningData = true;
  }

  S.installed = true;
  S.enabled = true;
}

export function updateHotkeys(cfg?: HotkeyConfig): void {
  if (!cfg) return;
  if (cfg.interjectKey) S.interjectKey = cfg.interjectKey;
  if (typeof cfg.allowInterject === "boolean") S.allowInterject = cfg.allowInterject;
}

export function disposeHotkeys(): void {
  if (!S.installed) return;
  clearEscTimer();
  if (S.listeningKeypress) {
    try { process.stdin.removeListener("keypress", handleKeypress); } catch {}
    S.listeningKeypress = false;
  }
  if (S.listeningData) {
    try { process.stdin.removeListener("data", handleDataChunk); } catch {}
    S.listeningData = false;
  }
  // Leave raw mode decisions to the caller; we don't force cooked/raw here.
  S.installed = false;
}

export function suspendHotkeys(): void {
  S.enabled = false;
  clearEscTimer();
}

export function resumeHotkeys(): void {
  S.enabled = true;
}

// ---- test helper ------------------------------------------------------------

/**
 * In tests we don’t want debounce delays — fire immediately.
 */
export function __testOnly_emit(k: { name?: string; ctrl?: boolean; sequence?: string }) {
  const name = lower(k.name);
  if (k.ctrl && name === "c") { S.onCtrlC?.(); return; }
  if (name === "escape") { clearEscTimer(); S.onEsc?.(); return; }
  if (S.allowInterject && name === lower(S.interjectKey)) { S.onInterject?.(); }
}
