/**
 * Centralized low-level hotkey manager for org.
 *
 * - Attaches exactly one key listener (keypress + raw "data" fallback).
 * - Distinguishes real ESC from arrow-key sequences using a short debounce.
 * - Provides suspend()/resume() so readline can own the TTY during prompts.
 *
 * Public API:
 *   installHotkeys(handlers, cfg?)
 *   updateHotkeys(cfg)
 *   disposeHotkeys()
 *   suspendHotkeys()
 *   resumeHotkeys()
 *
 * Test helper:
 *   __testOnly_emit(k)   // immediate (no debounce)
 */

import * as readline from "readline";

export type HotkeyHandlers = {
  onEsc?: () => void;
  onCtrlC?: () => void;
  onInterject?: () => void;
};

export type HotkeyConfig = {
  interjectKey?: string;      // default: "i"
  allowInterject?: boolean;   // default: true
};

type State = HotkeyHandlers & Required<HotkeyConfig> & {
  installed: boolean;
  enabled: boolean;     // suspend/resume gate
  listeningKeypress: boolean;
  listeningData: boolean;
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

const DBG = !!process.env.DEBUG_HOTKEYS;
const dlog = (...a: any[]) => { if (DBG) console.error("[hotkeys]", ...a); };

function lower(s?: string) { return (s ?? "").toLowerCase(); }
function clearEscTimer() { if (S.escTimer) { clearTimeout(S.escTimer); S.escTimer = null; } }
function ensureRawAndFlow() {
  const any = process.stdin as any;
  if (process.stdin.isTTY && typeof any.setRawMode === "function") {
    try { any.setRawMode(true); } catch {}
  }
  try { process.stdin.resume(); } catch {}
}

// ---------------------------------------------------------------------------

function handleKeypress(_str: string, key: readline.Key) {
  if (!S.enabled || !key) return;

  // Ctrl+C = fast abort (no debounce)
  if (key.ctrl && lower(key.name) === "c") {
    dlog("ctrl+c");
    S.onCtrlC?.();
    return;
  }

  const name = lower(key.name);

  // Esc (standalone) → debounce a tiny bit in case it's a CSI sequence
  if (name === "escape") {
    dlog("escape (keypress)");
    clearEscTimer();
    S.escTimer = setTimeout(() => {
      dlog("escape → onEsc()");
      S.onEsc?.();
      S.escTimer = null;
    }, 25);
    return;
  }

  // Single-letter interject
  if (S.allowInterject && name === lower(S.interjectKey)) {
    dlog("interject", name);
    S.onInterject?.();
  }
}

/**
 * Raw fallback when 'keypress' is flaky.
 *   '\x03'     → Ctrl+C
 *   '\x1B['…   → Arrow/CSI → cancel a pending Esc
 *   '\x1B'     → Esc (debounced)
 */
function handleDataChunk(buf: Buffer) {
  if (!S.enabled || !buf || buf.length === 0) return;
  const s = buf.toString("utf8");

  if (s === "\x03") { dlog("data ^C"); S.onCtrlC?.(); return; }

  if (s.startsWith("\x1B[")) { dlog("data CSI (cancel Esc)"); clearEscTimer(); return; }

  if (s === "\x1B") {
    dlog("data ESC");
    clearEscTimer();
    S.escTimer = setTimeout(() => {
      dlog("data ESC → onEsc()");
      S.onEsc?.();
      S.escTimer = null;
    }, 25);
    return;
  }

  if (S.allowInterject && lower(s) === lower(S.interjectKey)) {
    dlog("data interject", s);
    S.onInterject?.();
  }
}

// ---------------------------------------------------------------------------

export function installHotkeys(handlers: HotkeyHandlers, cfg?: HotkeyConfig): void {
  // refresh config/handlers every call; attach listeners once
  S.onEsc = handlers.onEsc;
  S.onCtrlC = handlers.onCtrlC;
  S.onInterject = handlers.onInterject;

  if (cfg) updateHotkeys(cfg);

  if (!S.installed) {
    // Make sure keypress events are emitted
    try { readline.emitKeypressEvents(process.stdin as any); } catch {}
    ensureRawAndFlow();

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
    dlog("installed");
  } else {
    // already installed → just ensure raw+flow in case caller toggled modes
    ensureRawAndFlow();
  }
}

export function updateHotkeys(cfg?: HotkeyConfig): void {
  if (!cfg) return;
  if (cfg.interjectKey) S.interjectKey = cfg.interjectKey;
  if (typeof cfg.allowInterject === "boolean") S.allowInterject = cfg.allowInterject;
  dlog("update cfg", { interjectKey: S.interjectKey, allowInterject: S.allowInterject });
}

export function disposeHotkeys(): void {
  if (!S.installed) return;
  clearEscTimer();
  if (S.listeningKeypress) { try { process.stdin.removeListener("keypress", handleKeypress); } catch {} S.listeningKeypress = false; }
  if (S.listeningData) { try { process.stdin.removeListener("data", handleDataChunk); } catch {} S.listeningData = false; }
  S.installed = false;
  dlog("disposed");
}

export function suspendHotkeys(): void {
  S.enabled = false;
  clearEscTimer();
  dlog("suspend");
}

export function resumeHotkeys(): void {
  S.enabled = true;
  ensureRawAndFlow();   // <- critical so keys flow again
  dlog("resume");
}

/** Test helper: immediate (no debounce) */
export function __testOnly_emit(k: { name?: string; ctrl?: boolean }) {
  const n = lower(k.name);
  if (k.ctrl && n === "c") { S.onCtrlC?.(); return; }
  if (n === "escape") { S.onEsc?.(); return; }
  if (S.allowInterject && n === lower(S.interjectKey)) { S.onInterject?.(); }
}
