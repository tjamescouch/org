/* src/input/controller.ts
   Interactive input layer.

   What’s new (small + safe):
   - attachScheduler() now auto-starts a singleton input loop (TTY only).
     This prevents the app from exiting immediately when the caller forgets
     to start the controller. It routes:
       • Enter / 'i' -> scheduler.handleUserInterjection(text)
       • Esc         -> scheduler.stop() + finalizer()
       • Ctrl+C      -> just signal (no finalize)
   - Existing APIs remain:
       createInputController(), makeControllerForTests(),
       attachScheduler(), attachFinalizer(), and value export InputController.
   - Debug: set ORG_DEBUG_INPUT=1 for keypress traces.
*/

import readline from "node:readline";
import { EventEmitter } from "node:events";

type Logger = (msg: string) => void;
const debugOn = process.env.ORG_DEBUG_INPUT === "1";
const log: Logger = (m) => {
  if (!debugOn) return;
  const ts = new Date().toISOString();
  // stderr so logs don’t intermix with normal stdout
  // eslint-disable-next-line no-console
  console.error(`[${ts}] [input] ${m}`);
};

export interface Hooks {
  onLine: (text: string) => void;
  onInterject?: (text: string) => void;
  onEscape?: () => void;
  onCtrlC?: () => void;
  onCtrlZ?: () => void;
}

export interface Controller {
  start(): void;
  stop(): void;
  _private: {
    emitKey: (k: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => void;
  };
}

/* ---------- Global wiring used by app.ts ---------- */

let _attachedScheduler:
  | { stop?: () => void; handleUserInterjection?: (s: string) => void }
  | null = null;
let _attachedFinalizer: (() => void | Promise<void>) | null = null;

/** Allow the app to provide the finalizer we should trigger on graceful exit. */
export function attachFinalizer(fn: () => void | Promise<void>) {
  _attachedFinalizer = fn ?? null;
  log(`attachFinalizer: ${_attachedFinalizer ? "ok" : "cleared"}`);
}

/* ---------- Core controller factory (unchanged behavior) ---------- */

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

  const onKeypress = (
    _chunk: string,
    key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }
  ) => {
    if (!key) return;
    const { name, ctrl } = key;
    log(`keypress: name=${name} ctrl=${!!ctrl} seq=${JSON.stringify(key.sequence ?? "")}`);

    if (name === "c" && ctrl) {
      hooks.onCtrlC?.();
      return;
    }
    if (name === "z" && ctrl) {
      hooks.onCtrlZ?.();
      return;
    }
    if (name === "escape") {
      hooks.onEscape?.();
      return;
    }
    if (name === "i" && !ctrl) {
      // Grab the current buffer from readline
      // @ts-expect-error private field access
      const buf: string = (rl as any).line ?? "";
      hooks.onInterject?.(buf);
      rl.clearLine(0);
      rl.prompt();
      return;
    }
    // Enter is handled by 'line'
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

  emitter.on("emitKey", (k) => onKeypress("", k as any));

  return {
    start,
    stop,
    _private: {
      emitKey: (k) => emitter.emit("emitKey", k),
    },
  };
}

/* ---------- Singleton auto-loop (new) ---------- */

let _singletonCtl: Controller | null = null;
let _singletonStarted = false;

function ensureSingletonLoop() {
  if (!process.stdin.isTTY) {
    log("singleton: not starting (stdin not a TTY)");
    return;
  }
  if (_singletonStarted) return;

  // Wire hooks to the attached scheduler/finalizer.
  const ctl = createInputController({
    onLine: (text) => {
      _attachedScheduler?.handleUserInterjection?.(text);
    },
    onInterject: (text) => {
      _attachedScheduler?.handleUserInterjection?.(text);
    },
    onEscape: () => {
      try {
        _attachedScheduler?.stop?.();
      } finally {
        if (_attachedFinalizer) {
          try { void Promise.resolve(_attachedFinalizer()); } catch {}
        }
      }
    },
    onCtrlC: () => {
      // Immediate abort path should NOT finalize by default.
      log("Ctrl+C (singleton) – ignoring finalize");
    },
  });

  ctl.start();
  _singletonCtl = ctl;
  _singletonStarted = true;
  log("singleton: started");
}

/** Called by app.ts; now ALSO starts an interactive loop (TTY) if not already running. */
export function attachScheduler(scheduler: {
  stop?: () => void;
  handleUserInterjection?: (s: string) => void;
}) {
  _attachedScheduler = scheduler ?? null;
  log(`attachScheduler: ${_attachedScheduler ? "ok" : "cleared"}`);

  // If the app forgets to create/start a controller, keep it interactive.
  // This prevents the process from exiting immediately and dumping the user into the shell.
  ensureSingletonLoop();
}

/* ---------- Test helper (unchanged) ---------- */

export const makeControllerForTests = (opts: {
  scheduler: { stop?: () => void } & Record<string, unknown>;
  finalizer: () => void | Promise<void>;
}): Controller => {
  const ctl = createInputController({
    onLine: () => {},
    onInterject: () => {},
    onEscape: () => {
      try { opts.scheduler?.stop?.(); } catch {}
      Promise.resolve().then(() => opts.finalizer()).catch(() => {});
    },
    onCtrlC: () => { /* do not finalize on Ctrl+C */ },
  });
  return ctl;
};

/* Value alias so `import { InputController } ...` works at runtime. */
export { createInputController as InputController };
