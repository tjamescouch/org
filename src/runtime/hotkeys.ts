// src/runtime/hotkeys.ts
//
// Hotkey runtime for Node/Bun.
// - IDLE: put TTY in RAW mode, no echo; listen on 'data'.
// - PROMPTING (readline): suspend (restore cooked), detach listener.
// - Debounces bare ESC so we don't confuse it with CSI sequences.
// - Handles Ctrl+C and one configurable interject key.
//
// Testing: __testOnly_emit() feeds the same handler used by runtime.

type Handlers = {
  onEsc?: () => void;
  onCtrlC?: () => void;
  onInterject?: () => void;
};

type Options = {
  interjectKey?: string;       // default 'i'
  allowInterject?: boolean;    // default true
};

const state = {
  installed: false,
  suspended: false,
  allowInterject: true,
  interjectKey: "i",
  handlers: {} as Handlers,
  onData: null as ((buf: Buffer) => void) | null,

  // ESC debounce
  escPending: false,
  escTimer: null as NodeJS.Timeout | null,
};

function isTTY() {
  return !!(process.stdin && process.stdin.isTTY);
}

function setRawMode(enable: boolean) {
  const anyIn: any = process.stdin as any;
  if (!isTTY()) return;
  try {
    if (typeof anyIn.setRawMode === "function") anyIn.setRawMode(!!enable);
    if (enable) {
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
    }
  } catch {
    /* non-tty envs */
  }
}

/** Call this whenever we decide a bare ESC actually happened. */
function fireEsc() {
  state.escPending = false;
  if (state.escTimer) { clearTimeout(state.escTimer); state.escTimer = null; }
  state.handlers.onEsc?.();
}

/** Core path used by real 'data' and tests. */
function handleChunk(chunk: Buffer | string) {
  if (!state.installed || state.suspended) return;

  const buf: Buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), "utf8");

  const len = buf.length;
  if (len === 0) return;

  // Ctrl+C (ETX)
  if (buf[0] === 0x03) {
    state.handlers.onCtrlC?.();
    return;
  }

  // ---- ESC handling with debounce ---------------------------------
  // If this is *exactly* one ESC byte, don't fire immediately; wait a hair
  // to see if more bytes arrive (CSI or Alt+key). This avoids mis-fires.
  if (len === 1 && buf[0] === 0x1b) {
    // If another bare ESC is already pending, restart the timer.
    if (state.escTimer) { clearTimeout(state.escTimer); state.escTimer = null; }
    state.escPending = true;
    state.escTimer = setTimeout(() => {
      if (state.escPending) fireEsc();
    }, 35); // ~25–50ms is typical; 35ms balances latency/safety
    return;
  }

  // If bytes arrive while ESC is pending, it's *not* a lone ESC.
  if (state.escPending) {
    state.escPending = false;
    if (state.escTimer) { clearTimeout(state.escTimer); state.escTimer = null; }
  }

  // CSI sequences (arrows, Home/End, etc) start with ESC '['.
  if (len >= 2 && buf[0] === 0x1b && buf[1] === 0x5b) {
    return; // ignore navigation keys entirely
  }

  // Allow a single printable char as interject
  if (state.allowInterject && len === 1) {
    const ch = String.fromCharCode(buf[0]).toLowerCase();
    if (ch === state.interjectKey) {
      state.handlers.onInterject?.();
      return;
    }
  }

  // Otherwise: ignore. (We don't treat Alt+<key> as interject.)
}

function attach() {
  if (!isTTY() || state.onData) return;
  state.onData = (buf: Buffer | string) => handleChunk(buf);
  process.stdin.on("data", state.onData!);
}

function detach() {
  if (!state.onData) return;
  try { process.stdin.off("data", state.onData); } catch {}
  state.onData = null;
}

/** Install hotkeys and enter raw/no-echo idle mode (if TTY). */
export function installHotkeys(handlers: Handlers, opts?: Options) {
  state.handlers = handlers || {};
  state.interjectKey = (opts?.interjectKey ?? "i").toLowerCase();
  state.allowInterject = opts?.allowInterject !== false;
  state.installed = true;
  state.suspended = false;

  if (isTTY()) {
    setRawMode(true);
    attach();
  }

  process.once("exit", () => {
    try { detach(); } catch {}
    try { setRawMode(false); } catch {}
  });
}

/** Update hotkey settings (e.g., enable/disable interject). */
export function updateHotkeys(opts: Partial<Options>) {
  if (typeof opts.interjectKey === "string") {
    state.interjectKey = opts.interjectKey.toLowerCase();
  }
  if (typeof opts.allowInterject === "boolean") {
    state.allowInterject = opts.allowInterject;
  }
}

/** Temporarily disable hotkeys and restore cooked TTY (for readline). */
export function suspendHotkeys() {
  if (!state.installed || state.suspended) return;
  state.suspended = true;
  if (!isTTY()) return;
  detach();
  setRawMode(false);
}

/** Re-enable hotkeys and restore raw/no-echo idle mode. */
export function resumeHotkeys() {
  if (!state.installed || !state.suspended) return;
  state.suspended = false;
  if (!isTTY()) return;
  setRawMode(true);
  attach();
}

/** Remove listeners and restore cooked mode. */
export function disposeHotkeys() {
  if (!state.installed) return;
  state.installed = false;
  state.suspended = false;
  if (isTTY()) {
    detach();
    setRawMode(false);
  }
}

/* ---------------------------- Test utilities ---------------------------- */

/** Feed the same pipeline as the real 'data' listener. */
export function __testOnly_emit(
  k: string | Buffer | { name: string; ctrl?: boolean }
) {
  if (typeof k === "string" || Buffer.isBuffer(k)) { handleChunk(k as any); return; }

  const name = (k.name || "").toLowerCase();
  if (k.ctrl && name === "c") { handleChunk(Buffer.from([0x03])); return; }
  if (name === "escape" || name === "esc") { handleChunk(Buffer.from([0x1b])); return; }
  if (name === "up")   { handleChunk("\x1b[A"); return; }
  if (name === "down") { handleChunk("\x1b[B"); return; }
  if (name === "right"){ handleChunk("\x1b[C"); return; }
  if (name === "left") { handleChunk("\x1b[D"); return; }
  if (name.length === 1) { handleChunk(name); }
  // else: no-op
}
