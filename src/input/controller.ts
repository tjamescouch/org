/* src/input/controller.ts
   Input controller with:
   - optional hooks (no hard requirement for onEscape/onInterject/etc.)
   - test helper makeControllerForTests({ scheduler, finalizer }) that maps ESC to
     scheduler.stop() and finalizer() to satisfy sanity tests
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

  const onKeypress = (
    _chunk: string,
    key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }
  ) => {
    if (!key) return;
    const { name, ctrl } = key;
    log(`keypress: name=${name} ctrl=${!!ctrl} seq=${JSON.stringify(key.sequence ?? "")}`);

    // Ctrl+C: immediate abort; DO NOT finalize here.
    if (name === "c" && ctrl) {
      hooks.onCtrlC?.();
      return;
    }

    // Ctrl+Z: optional behavior.
    if (name === "z" && ctrl) {
      hooks.onCtrlZ?.();
      return;
    }

    // Escape: graceful finalize path; optional for tests.
    if (name === "escape") {
      hooks.onEscape?.();
      return;
    }

    // Interjection: hotkey 'i' (single key)
    if (name === "i" && !ctrl) {
      // Grab the current buffer (private but stable in Node)
      // @ts-expect-error accessing private field
      const buf: string = (rl as any).line ?? "";
      hooks.onInterject?.(buf);
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

export class InputController {
  private readonly opts: Required<InputControllerOptions>;

  private scheduler: any | null = null;
  private submitting: SubmitFn | null = null;
  private submittingName: string | null = null;

  private fsm: InputFSM;
  private rawWasOn = false;
  private keyDebug = false;

  private pendingResolve: ((s: string) => void) | null = null;

  // ESC single‑press guard
  private escInProgress = false;

  constructor(opts: InputControllerOptions = {}) {
    const isTest =
      R.env.BUN_TESTING === "1" ||
      R.env.JEST_WORKER_ID != null ||
      R.env.ORG_TEST === "1";

    this.opts = {
      interjectKey: opts.interjectKey ?? "i",
      interjectBanner: opts.interjectBanner ?? "You: ",
      finalizer: opts.finalizer ?? (() => {}),
      exitOnEsc: opts.exitOnEsc ?? true,
      fastExitOnCtrlC: opts.fastExitOnCtrlC ?? !isTest,
      suspendOnCtrlZ: opts.suspendOnCtrlZ ?? !isTest,
    };

    this.keyDebug = (R.env.ORG_KEY_DEBUG === "1" || R.env.DEBUG === "1");

    // Install a very narrow stdout filter that only touches right‑edge INFO tails.
    this.installRightEdgeInfoNormalizer();

    // FSM wiring
    this.fsm = new InputFSM(
      {
        write: (s: string) => { try { R.stdout.write(s); } catch {} },
        bell:  () => { try { R.stdout.write("\x07"); } catch {} },
      },
      {
        banner: this.opts.interjectBanner,
        interjectKey: this.opts.interjectKey,
        onSubmit: (text) => this.submitText(text),
        onCancel:  () => this.setUIBusy(false),
        onEscapeIdle: () => this.handleEscapeIdle(),
      }
    );

    InputController._active = this;
    this._attachKeys();

    try {
      R.on?.("SIGCONT", () => {
        Logger.debug("[input] SIGCONT -> re-enabling raw mode");
        this.enableRaw();
      });
    } catch { /* ignore */ }
  }

  // ---- public API -----------------------------------------------------------

  attachScheduler(s: any) {
    this.scheduler = s;
    const pick = this.pickSubmitFn(s);
    this.submitting = pick.fn;
    this.submittingName = pick.name;
    if (pick.name) Logger.debug(`[input] bound scheduler submit: ${pick.name}`);
    else Logger.warn("[input] no scheduler submit function found");
  }

  async askUser(_fromAgent: string, _content: string): Promise<string> {
    return await this.promptOnce();
  }

  async askInitialAndSend(kickoff?: string | boolean) {
    if (kickoff === true) {
      await this.promptOnce();
    } else if (typeof kickoff === "string" && kickoff.length > 0) {
      this.submitText(kickoff);
    }
  }

  // ---- stdin wiring ---------------------------------------------------------

  private onData = (chunk: Buffer) => {
    const s = chunk.toString("utf8");

    // Ctrl+C
    if (s === "\x03") {
      Logger.debug("[input] Ctrl+C");
      if (this.opts.fastExitOnCtrlC) {
        try { this.disableRaw(); } catch {}
        try { (R as any).exit?.(130); } catch { try { (globalThis as any).process?.exit?.(130); } catch {} }
      }
      return;
    }

    // Ctrl+Z
    if (s === "\x1A" && this.opts.suspendOnCtrlZ) {
      Logger.debug("[input] Ctrl+Z -> suspend");
      try { this.disableRaw(); } catch {}
      try { (globalThis as any).process?.kill?.((globalThis as any).process?.pid, "SIGTSTP"); } catch {}
      return;
    }

    // ESC graceful stop (once)
    if (s === "\x1B" && !this.pendingResolve) {
      if (!this.escInProgress) {
        this.escInProgress = true;
        Logger.debug("[input] ESC (idle) -> graceful stop");
        void this.handleEscapeIdle().finally(() => { this.escInProgress = false; });
      }
      return;
    }

    const ev = decodeKey(chunk);
    if (this.keyDebug) {
      try { R.stderr.write(`[key] ${JSON.stringify(ev)}\n`); } catch {}
    }

    if (!this.pendingResolve && isInterjectHotkey(ev, this.opts.interjectKey)) {
      this.openInterjectNow();
      return;
    }

    this.fsm.handle(ev);
  };

  private _attachKeys() {
    this.enableRaw();
    try { R.stdin.on("data", this.onData); } catch {}
    const restore = () => this.disableRaw();
    R.on("exit", restore);
    R.on("beforeExit", restore);
  }

  private enableRaw() {
    const stdin: any = R.stdin as any;
    if (stdin?.isTTY) {
      this.rawWasOn = !!stdin.isRaw;
      if (!stdin.isRaw && typeof stdin.setRawMode === "function") {
        try { stdin.setRawMode(true); } catch {}
      }
    }
    try { R.stdin.resume(); } catch {}
  }
  private disableRaw() {
    const stdin: any = R.stdin as any;
    if (stdin?.isTTY && !this.rawWasOn && typeof stdin.setRawMode === "function") {
      try { stdin.setRawMode(false); } catch {}
    }
  }

  // ---- behaviors ------------------------------------------------------------

  private async handleEscapeIdle() {
    try {
      const s = this.scheduler;
      if (s && typeof s.stop === "function") {
        try { s.stop(); } catch (e: any) { Logger.warn(`[input] scheduler.stop() error: ${e?.message || e}`); }
      }
    } finally {
      try { await this.opts.finalizer(); }
      catch (e: any) { Logger.warn(`[input] finalizer error: ${e?.message || e}`); }
      if (this.opts.exitOnEsc) {
        try { R.stdout.write("\n"); } catch {}
      }
    }
  }

  private async promptOnce(): Promise<string> {
    if (this.pendingResolve) {
      return await new Promise<string>((resolve) => {
        const prev = this.pendingResolve!;
        this.pendingResolve = (s: string) => { try { prev(s); } catch {}; resolve(s); };
      });
    }
    return await new Promise<string>((resolve) => {
      this.pendingResolve = (s: string) => {
        this.pendingResolve = null;
        this.setUIBusy(false); // leaving prompt: allow fills again
        const out = (s ?? "");
        Logger.debug(`[input] prompt resolved (${out.length} chars)`);
        resolve(out);
      };
      this.openInterjectNow();
    });
  }

  private submitText(t: string) {
    const text = String(t ?? "");
    const hadPrompt = !!this.pendingResolve;

    if (hadPrompt) {
      const resolve = this.pendingResolve; this.pendingResolve = null;
      this.setUIBusy(false);
      try { resolve!(text); } catch {}
      return; // do NOT also forward to scheduler
    }

    if (text && this.scheduler && this.submitting) {
      Logger.debug(`[input] background submit via ${this.submittingName}: ${JSON.stringify(text)}`);
      try { this.submitting(text); } catch (e: any) {
        Logger.warn(`[input] scheduler submit failed: ${e?.message || e}`);
      }
    } else {
      Logger.debug("[input] background submit dropped (no scheduler submit bound)");
    }
  }

  // ---- helpers --------------------------------------------------------------

  private setUIBusy(b: boolean) {
    try {
      const anyR = R as any;
      if (typeof anyR.setUIBusy === "function") { anyR.setUIBusy(b); return; }
      if ("uiBusy" in anyR) { anyR.uiBusy = b; return; }
      (anyR as any).UIBusy = b;
    } catch { /* ignore */ }
  }

  private openInterjectNow() {
    this.setUIBusy(true);                 // pause any cosmetic fills
    try { R.stdout.write("\r\x1b[K"); } catch {} // draw on a clean line
    this.fsm.handle({ type: "char", data: this.opts.interjectKey });
  }

  private pickSubmitFn(s: any): { fn: SubmitFn | null; name: string | null } {
    const preferred = (R.env.ORG_SCHEDULER_SUBMIT || "").trim();
    if (preferred && typeof s?.[preferred] === "function") {
      return { fn: (t: string) => s[preferred](t), name: preferred };
    }
    const candidates = [
      "handleUserInterjection",
      "receiveUser",
      "interject",
      "submitUser",
      "submit",
      "enqueueUser",
      "onUserInput",
    ];
    for (const name of candidates) {
      if (typeof s?.[name] === "function") return { fn: (t: string) => s[name](t), name };
    }
    return { fn: null, name: null };
  }

  // ---- stdout normalizer ----------------------------------------------------

  /**
   * Only touches lines that *end* with dotted/box-drawing filler + "INFO".
   *  - If the part before INFO is pure filler (or "You:" + filler), drop the line.
   *  - If there's real content before the filler, strip the filler + INFO and keep content.
   * Works line-by-line; does not buffer partial chunks.
   */
  private installRightEdgeInfoNormalizer() {
    try {
      const out: any = R.stdout as any;
      const orig = out.write.bind(out);

      out.write = (chunk: any, ...rest: any[]) => {
        let s: string;
        try {
          s =
            typeof chunk === "string"
              ? chunk
              : Buffer.isBuffer(chunk)
              ? chunk.toString("utf8")
              : String(chunk ?? "");
        } catch {
          return orig(chunk, ...rest);
        }

        if (s.indexOf("\n") === -1) {
          // No newline => do not reformat streaming tokens.
          return orig(chunk, ...rest);
        }

        const lines = s.split("\n");
        for (let i = 0; i < lines.length - 1; i++) { // process full lines only
          const raw = lines[i];
          const stripped = stripAnsi(raw);
          const normalized = normalizeRightInfoLine(stripped);

          if (normalized === null) {
            // drop the line entirely (pure filler + INFO)
            lines[i] = "";
          } else if (normalized !== stripped) {
            // replaced content; we lose ANSI coloring on that line (acceptable for filler lines)
            lines[i] = normalized;
          } // else leave as-is
        }

        const rebuilt = lines.join("\n");
        return orig(rebuilt, ...rest);
      };
    } catch { /* ignore */ }
  }

  // ---- static hook for tty-guard -------------------------------------------
  private static _active: InputController | null = null;
  static disableKeys() { this._active?._detachKeys(); }
  static enableKeys() { this._active?._attachKeys(); }
  private _detachKeys() { try { R.stdin.off?.("data", this.onData); } catch {}; this.disableRaw(); }
}