// src/runtime/hotkeys.ts
//
// Minimal hotkey runtime that works in Node and Bun.
// - While IDLE: set stdin to RAW and listen on 'data' (no echo).
// - While prompting: suspend (restore cooked), detach listener.
// - Distinguish plain ESC (\x1b) from escape sequences (\x1b[... like arrows).
// - Handle Ctrl+C and configurable interject key ('i' by default).
//
// Includes a test helper __testOnly_emit(...) that drives the same handler
// path used by the real data events, so unit tests work even without a TTY.

type Handlers = {
  onEsc?: () => void;
  onCtrlC?: () => void;
  onInterject?: () => void;
};

type Options = {
  interjectKey?: string;       // default: 'i'
  allowInterject?: boolean;    // default: true
};

const state = {
  installed: false,
  suspended: false,
  allowInterject: true,
  interjectKey: "i",
  handlers: {} as Handlers,
  onData: null as ((buf: Buffer) => void) | null,
};

function isTTY() {
  return !!(process.stdin && process.stdin.isTTY);
}

function setRawMode(enable: boolean) {
  const anyIn: any = process.stdin as any;
  if (!isTTY()) return;
  try {
    if (typeof anyIn.setRawMode === "function") {
      anyIn.setRawMode(!!enable);
    }
    if (enable) {
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
    }
  } catch {
    /* ignore non-interactive envs */
  }
}

/** Core handler used by both the real 'data' listener and tests. */
function handleChunk(chunk: Buffer | string) {
  if (!state.installed || state.suspended) return;

  // Normalize to Buffer
  const buf: Buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), "utf8");

  const len = buf.length;

  // Ctrl+C (ETX)
  if (len >= 1 && buf[0] === 0x03) {
    state.handlers.onCtrlC?.();
    return;
  }

  // Plain ESC as a single byte
  if (len === 1 && buf[0] === 0x1b) {
    state.handlers.onEsc?.();
    return;
  }

  // Ignore CSI escape sequences like arrows: \x1b[...
  if (len >= 2 && buf[0] === 0x1b && buf[1] === 0x5b) {
    return;
  }

  // Interject key (case-insensitive, one printable char)
  if (state.allowInterject && len === 1) {
    const ch = String.fromCharCode(buf[0]).toLowerCase();
    if (ch === state.interjectKey) {
      state.handlers.onInterject?.();
      return;
    }
  }
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

/** Update hotkey settings while running. */
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

/* ------------------------------------------------------------------ */
/* ------------------------ Test utilities --------------------------- */
/* ------------------------------------------------------------------ */

/**
 * Drive the hotkey pipeline without a TTY.
 * Accepts either a raw string/Buffer or a minimal key object compatible
 * with how your tests emit events, e.g.:
 *   __testOnly_emit({ name: "escape" })
 *   __testOnly_emit({ name: "c", ctrl: true })
 */
export function __testOnly_emit(
  k:
    | string
    | Buffer
    | { name: string; ctrl?: boolean }
) {
  if (typeof k === "string" || Buffer.isBuffer(k)) {
    handleChunk(k as any);
    return;
  }

  // Map a few common names to bytes used by handleChunk
  const name = (k.name || "").toLowerCase();

  if (k.ctrl && (name === "c")) {
    handleChunk(Buffer.from([0x03])); // ^C
    return;
  }
  if (name === "escape" || name === "esc") {
    handleChunk(Buffer.from([0x1b]));
    return;
  }
  if (name === "up")   { handleChunk("\x1b[A"); return; }
  if (name === "down") { handleChunk("\x1b[B"); return; }
  if (name === "right"){ handleChunk("\x1b[C"); return; }
  if (name === "left") { handleChunk("\x1b[D"); return; }

  if (name.length === 1) {
    handleChunk(name);
    return;
  }
  // Unknown -> no-op
}
