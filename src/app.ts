/* src/input/controller.ts
   Input controller with:
   - optional hooks (no hard requirement for onEscape/onInterject/etc.)
   - attachScheduler/attachFinalizer globals for production app wiring
   - test helper makeControllerForTests({ scheduler, finalizer })
   - opt-in debug logging: set ORG_DEBUG_INPUT=1
*/

import readline from "node:readline";
import { EventEmitter } from "node:events";

type Logger = (msg: string) => void;

const debugOn = process.env.ORG_DEBUG_INPUT === "1";
const log: Logger = (m) => {
  if (!debugOn) return;
  const ts = new Date().toISOString();
  // stderr so logs don’t interfere with normal stdout
  // eslint-disable-next-line no-console
  console.error(`[${ts}] [input] ${m}`);
};

/** Scheduler + finalizer the app can attach without passing hooks explicitly. */
let _attachedScheduler:
  | { stop?: () => void; handleUserInterjection?: (s: string) => void }
  | null = null;
let _attachedFinalizer: (() => void | Promise<void>) | null = null;

/** Called by app.ts to wire ESC/Ctrl+C behavior without custom hooks. */
export function attachScheduler(scheduler: {
  stop?: () => void;
  handleUserInterjection?: (s: string) => void;
}) {
  _attachedScheduler = scheduler ?? null;
  log(`attachScheduler: ${_attachedScheduler ? "ok" : "cleared"}`);
}

/** Optional: lets the app provide a finalizer the input layer can invoke. */
export function attachFinalizer(fn: () => void | Promise<void>) {
  _attachedFinalizer = fn ?? null;
  log(`attachFinalizer: ${_attachedFinalizer ? "ok" : "cleared"}`);
}

export interface Hooks {
  /** Fired when user hits Enter (full line available). */
  onLine: (text: string) => void;

  /** Fired when user presses the interjection hotkey ('i'). */
  onInterject?: (text: string) => void;

  /** Fired when user presses Escape (graceful finalize). */
  onEscape?: () => void;

  /** Fired on Ctrl+C (immediate abort). */
  onCtrlC?: () => void;

  /** Fired on Ctrl+Z (optional noop/suspend behavior). */
  onCtrlZ?: () => void;
}

export interface Controller {
  start(): void;
  stop(): void;
  _private: {
    /** Test hook to synthesize a keypress without a TTY. */
    emitKey: (k: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => void;
  };
}

export function createInputController(hooks: Hooks): Controller {
  const emitter = new EventEmitter();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 0,
    prompt: "",
  });

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);
    try {
      process.stdin.setRawMode?.(true);
      log("stdin rawMode=true");
    } catch {
      log("stdin rawMode set failed (non-TTY?)");
    }
  } else {
    log("stdin is not a TTY");
  }

  let closed = false;

  const onLine = (line: string) => {
    log(`onLine: ${JSON.stringify(line)}`);
    try {
      hooks.onLine(line);
    } catch (e) {
      log(`onLine threw: ${(e as Error).message}`);
    }
  };

  const invokeFinalizer = () => {
    if (_attachedFinalizer) {
      try {
        void Promise.resolve(_attachedFinalizer());
      } catch { /* ignore */ }
    }
  };

  const onKeypress = (
    _chunk: string,
    key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }
  ) => {
    if (!key) return;
    const { name, ctrl } = key;
    log(`keypress: name=${name} ctrl=${!!ctrl} seq=${JSON.stringify(key.sequence ?? "")}`);

    // Ctrl+C: immediate abort; DO NOT finalize unless caller wants to.
    if (name === "c" && ctrl) {
      if (hooks.onCtrlC) {
        hooks.onCtrlC();
      } else {
        // fallback: do nothing but log
        log("Ctrl+C (no onCtrlC hook)");
      }
      return;
    }

    // Ctrl+Z: optional behavior.
    if (name === "z" && ctrl) {
      hooks.onCtrlZ?.();
      return;
    }

    // Escape: graceful finalize path
    if (name === "escape") {
      if (hooks.onEscape) {
        hooks.onEscape();
      } else {
        // Fallback to attached scheduler + finalizer
        _attachedScheduler?.stop?.();
        invokeFinalizer();
      }
      return;
    }

    // Interjection: hotkey 'i' (single key)
    if (name === "i" && !ctrl) {
      // Grab the current buffer (private but stable in Node)
      // @ts-expect-error accessing private field
      const buf: string = (rl as any).line ?? "";
      if (hooks.onInterject) {
        hooks.onInterject(buf);
      } else {
        _attachedScheduler?.handleUserInterjection?.(buf);
      }
      // Clear current line visually
      rl.clearLine(0);
      rl.prompt();
      return;
    }

    // Enter is handled by 'line' event.
  };

  const onSIGINT = () => {
    log("SIGINT");
    hooks.onCtrlC?.();
  };

  const start = () => {
    if (closed) return;
    log(`start: isTTY=${process.stdin.isTTY} raw=${(process.stdin as any).isRaw ?? false}`);
    rl.on("line", onLine);
    process.stdin.on("keypress", onKeypress);
    process.once("SIGINT", onSIGINT);
    log("ready: input controller active (press i/Esc/Enter)");
  };

  const stop = () => {
    if (closed) return;
    closed = true;
    log("stop()");
    try {
      rl.removeListener("line", onLine);
      (process.stdin as any).removeListener?.("keypress", onKeypress);
      process.removeListener("SIGINT", onSIGINT);
      rl.close();
    } finally {
      try {
        process.stdin.setRawMode?.(false);
        log("stdin rawMode=false");
      } catch {
        /* ignore */
      }
    }
  };

  // test shim – allow unit tests to synthesize keypresses without a TTY
  emitter.on("emitKey", (k) => onKeypress("", k as any));

  return {
    start,
    stop,
    _private: {
      emitKey: (k) => emitter.emit("emitKey", k),
    },
  };
}

/**
 * Back-compat helper used by tests.
 * The sanity tests construct the controller via:
 *   makeControllerForTests({ scheduler, finalizer })
 * and then synthesize keys (ESC/Ctrl+C). Wire those expectations here.
 */
export const makeControllerForTests = (opts: {
  scheduler: { stop?: () => void } & Record<string, unknown>;
  finalizer: () => void | Promise<void>;
}): Controller => {
  const ctl = createInputController({
    // Tests for ESC/Ctrl+C don’t care about line input or interjection content.
    onLine: () => {},
    onInterject: () => {},
    onEscape: () => {
      try {
        opts.scheduler?.stop?.();
      } catch { /* ignore */ }
      // finalize asynchronously; tests usually just assert it was invoked
      Promise.resolve()
        .then(() => opts.finalizer())
        .catch(() => { /* ignore */ });
    },
    onCtrlC: () => {
      // Explicitly *do not* call finalizer on Ctrl+C; tests assert no finalize.
    },
  });
  return ctl;
};

/* Provide a runtime value named `InputController` for compatibility with
   imports like `import { InputController } from './input/controller'`. */
export { createInputController as InputController };
