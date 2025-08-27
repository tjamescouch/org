// Robust, low-level hotkey handling for org.
// - Works directly on stdin 'data' bytes (raw mode)
// - ESC is only treated as ESC if no follow-up bytes arrive within ESC_DELAY_MS
//   (so arrow keys like ESC [ A don't trigger).
// - Provides suspend/resume for readline prompts.
// - Test surface: __testOnly_emit.

import { Logger } from "../logger";

type Handlers = {
  onEsc: () => void;
  onCtrlC: () => void;
  onInterject: () => void;
};

type Config = {
  interjectKey: string;   // single letter like "i"
  allowInterject: boolean;
};

let installed = false;
let suspended = false;

let handlers: Handlers = {
  onEsc: () => {},
  onCtrlC: () => {},
  onInterject: () => {},
};

let cfg: Config = {
  interjectKey: "i",
  allowInterject: true,
};

// esc handling
const ESC = 0x1b;
const CTRL_C = 0x03;
const ESC_DELAY_MS = 35;

let escTimer: NodeJS.Timeout | null = null;
let escPending = false;

let onDataRef: ((chunk: Buffer) => void) | null = null;

function setRawMode(enable: boolean) {
  const anyStdin: any = process.stdin as any;
  if (process.stdin.isTTY && typeof anyStdin.setRawMode === "function") {
    try { anyStdin.setRawMode(enable); } catch { /* ignore */ }
  }
}

function attach() {
  if (onDataRef) return;

  onDataRef = (chunk: Buffer) => {
    // DEBUG: uncomment for byte tracing
    // if (process.env.DEBUG) console.error(`[hotkeys] bytes:`, chunk);

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];

      // CTRL-C (ETX)
      if (b === CTRL_C) {
        // cancel a pending ESC if any
        if (escTimer) { clearTimeout(escTimer); escTimer = null; escPending = false; }
        handlers.onCtrlC();
        continue;
      }

      // ESC
      if (b === ESC) {
        // If a new ESC arrives, mark pending and arm timer.
        // If arrow keys or sequences follow, they'll arrive before timer fires.
        escPending = true;
        if (escTimer) clearTimeout(escTimer);
        escTimer = setTimeout(() => {
          if (escPending) handlers.onEsc();
          escPending = false;
          escTimer = null;
        }, ESC_DELAY_MS);
        continue;
      }

      // Any byte arriving while ESC is pending cancels "bare ESC"
      if (escPending) {
        escPending = false;
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        // This was likely part of an escape sequence (e.g., arrow key). Ignore.
        // We do NOT re-process this byte, because it's part of a sequence and
        // not meaningful as a hotkey here.
        continue;
      }

      // Interject key ('i' or 'I')
      if (cfg.allowInterject) {
        const lower = String.fromCharCode(b).toLowerCase();
        if (lower === cfg.interjectKey) {
          handlers.onInterject();
          continue;
        }
      }

      // otherwise ignore
    }
  };

  process.stdin.on("data", onDataRef);
}

function detach() {
  if (onDataRef) {
    try { process.stdin.removeListener("data", onDataRef); } catch { /* ignore */ }
    onDataRef = null;
  }
}

export function installHotkeys(h: Handlers, init: Partial<Config> = {}) {
  if (installed) return;
  handlers = { ...handlers, ...h };
  cfg = { ...cfg, ...init };

  if (!process.stdin.isTTY) {
    if (process.env.DEBUG) Logger.info("[hotkeys] stdin is not a TTY; hotkeys disabled");
    installed = true; // considered installed, but no-op
    return;
  }

  setRawMode(true);
  attach();
  installed = true;
  suspended = false;

  process.on("exit", () => {
    try { detach(); setRawMode(false); } catch {}
  });
}

export function updateHotkeys(next: Partial<Config>) {
  cfg = { ...cfg, ...next };
}

export function suspendHotkeys() {
  if (!installed || suspended) return;
  suspended = true;
  detach();
  setRawMode(false);
}

export function resumeHotkeys() {
  if (!installed || !suspended) return;
  setRawMode(true);
  attach();
  suspended = false;
}

export function disposeHotkeys() {
  if (!installed) return;
  detach();
  setRawMode(false);
  installed = false;
  suspended = false;
  if (escTimer) { clearTimeout(escTimer); escTimer = null; }
  escPending = false;
}

export function __testOnly_emit(k: { name?: string; ctrl?: boolean }) {
  const name = (k.name || "").toLowerCase();
  if (k.ctrl && name === "c") { handlers.onCtrlC(); return; }
  if (name === "escape" || name === "esc") { handlers.onEsc(); return; }
  if (name === cfg.interjectKey && cfg.allowInterject) { handlers.onInterject(); return; }
}
