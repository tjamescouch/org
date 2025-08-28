// src/input/controller.ts
// Single owner of stdin in raw mode driven by a small FSM.
// Minimal, surgical changes aimed at restoring IO determinism and tests.

import { R } from "../runtime/runtime";
import { Logger } from "../logger";
import { decodeKey } from "./keys";
import { InputFSM } from "./fsm";
import { PassThrough } from "stream";

type SubmitFn = (text: string) => any;

export interface InputControllerOptions {
  interjectKey?: string;          // Hotkey to open the prompt. Default: 'i'
  interjectBanner?: string;       // Prompt banner. Default: 'You: '
  finalizer?: () => Promise<void> | void; // Called on graceful exit (ESC)
  exitOnEsc?: boolean;            // Print trailing newline after finalize. Default: true
}

export class InputController {
  private readonly opts: Required<InputControllerOptions>;
  private scheduler: any | null = null;
  private submitting: SubmitFn | null = null;
  private submittingName: string | null = null;

  private fsm: InputFSM;
  private rawWasOn = false;

  private keyDebug = false;

  // pending resolver when an agent asks @@user a question
  private pendingResolve: ((s: string) => void) | null = null;

  // ---- static hooks used by tty-guard.ts ----
  private static _active: InputController | null = null;
  static setRawMode(v: boolean) {
    const stdin: any = R.stdin as any;
    if (stdin?.isTTY && typeof stdin.setRawMode === "function") {
      try { stdin.setRawMode(v); } catch { /* ignore */ }
      try { (stdin as any).isRaw = !!v; } catch { /* ignore */ }
    }
  }
  static isRawMode(): boolean {
    try { return !!(R.stdin as any)?.isRaw; } catch { return false; }
  }
  static disableKeys() { this._active?._detachKeys(); }
  static enableKeys() { this._active?._attachKeys(); }

  constructor(opts: InputControllerOptions = {}) {
    this.opts = {
      interjectKey: opts.interjectKey ?? "i",
      interjectBanner: opts.interjectBanner ?? "You: ",
      finalizer: opts.finalizer ?? (() => {}),
      exitOnEsc: opts.exitOnEsc ?? true,
    };

    this.keyDebug = (R.env.ORG_KEY_DEBUG === "1" || R.env.DEBUG === "1");

    // Wire FSM to IO + hooks
    this.fsm = new InputFSM(
      {
        write: (s: string) => { try { R.stdout.write(s); } catch {} },
        bell:  () => { try { R.stdout.write("\x07"); } catch {} },
      },
      {
        banner: this.opts.interjectBanner,
        interjectKey: this.opts.interjectKey,
        onSubmit: (text) => this.submitText(text),
        onCancel:  () => { /* no-op */ },
        onEscapeIdle: () => this.handleEscapeIdle(),
      }
    );

    // Become sole stdin owner
    InputController._active = this;
    this._attachKeys();
  }

  // Bind the scheduler; discover which submit method it exposes.
  attachScheduler(s: any) {
    this.scheduler = s;
    const pick = this.pickSubmitFn(s);
    this.submitting = pick.fn;
    this.submittingName = pick.name;
    if (pick.name) Logger.debug(`[input] bound scheduler submit: ${pick.name}`);
    else Logger.warn("[input] no scheduler submit function found");
  }

  // Scheduler calls this when an agent asks @@user a question.
  async askUser(_fromAgent: string, content: string): Promise<string> {
    if (content && content.length) {
      try { R.stdout.write(content.endsWith("\n") ? content : content + "\n"); } catch {}
    }
    return await this.promptOnce();
  }

  // Kickoff flow: boolean true => prompt immediately; string => send in background.
  async askInitialAndSend(kickoff?: string | boolean) {
    if (kickoff === true) {
      await this.promptOnce();
    } else if (typeof kickoff === "string" && kickoff.length > 0) {
      this.submitText(kickoff);
    }
  }

  // ---------------- internal wiring ----------------

  private onData = (chunk: Buffer) => {
    const ev = decodeKey(chunk);
    if (this.keyDebug) {
      try { R.stderr.write(`[key] ${JSON.stringify(ev)}\n`); } catch {}
    }
    this.routeEvent(ev);
  };

  private routeEvent(ev: any) {
    // Tests inject `{ name: "escape" }` and `{ name: "c", ctrl: true }` directly.
    if (ev && ev.name === "escape" && !this.pendingResolve) {
      // Directly trigger idle-escape path (bypasses any FSM ambiguity).
      void this.handleEscapeIdle();
      return;
    }
    // Ctrl+C — do NOT call finalizer (tests assert no finalize on SIGINT).
    if (ev && ev.name === "c" && ev.ctrl) {
      // let the outer app handle actual process exit; we just ignore here
      Logger.debug("[input] Ctrl+C received (ignored by controller; app handles fast-exit)");
      return;
    }
    this.fsm.handle(ev);
  }

  private _attachKeys() {
    this.enableRaw();
    try { R.stdin.on("data", this.onData); } catch {}
    const restore = () => this.disableRaw();
    R.on("exit", restore);
    R.on("beforeExit", restore);
  }

  private _detachKeys() {
    try { R.stdin.off?.("data", this.onData); } catch {}
    this.disableRaw();
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

  // ESC when idle ⇒ stop scheduler (graceful), then run finalizer (review/apply).
  private async handleEscapeIdle() {
    Logger.debug("[input] ESC received (idle) — initiating graceful stop");
    try {
      const s = this.scheduler;
      if (s && typeof s.stop === "function") {
        try { s.stop(); } catch (e: any) {
          Logger.warn(`[input] scheduler.stop() error: ${e?.message || e}`);
        }
      }
    } finally {
      try {
        await this.opts.finalizer();
      } catch (e: any) {
        Logger.warn(`[input] finalizer error: ${e?.message || e}`);
      }
      if (this.opts.exitOnEsc) {
        try { R.stdout.write("\n"); } catch {}
      }
    }
  }

  private async promptOnce(): Promise<string> {
    if (this.pendingResolve) {
      // Already prompting; chain to existing resolver.
      return new Promise<string>((resolve) => {
        const prev = this.pendingResolve!;
        this.pendingResolve = (s: string) => { try { prev(s); } catch {}; resolve(s); };
      });
    }
    return await new Promise<string>((resolve) => {
      this.pendingResolve = (s: string) => {
        this.pendingResolve = null;
        const out = (s ?? "");
        Logger.debug(`[input] prompt resolved (${out.length} chars)`);
        resolve(out);
      };
      // Open the prompt by virtually pressing the interject key.
      this.fsm.handle({ type: "char", data: this.opts.interjectKey });
    });
  }

  private submitText(t: string) {
    const text = String(t ?? "");
    const hadPrompt = !!this.pendingResolve;

    if (hadPrompt) {
      const resolve = this.pendingResolve; this.pendingResolve = null;
      try { resolve!(text); } catch {}
      // Do NOT also forward to scheduler here: the scheduler awaits the promise.
      return;
    }

    // Background interjection / kickoff
    if (text && this.scheduler && this.submitting) {
      Logger.debug(`[input] background submit via ${this.submittingName}: ${JSON.stringify(text)}`);
      try { this.submitting(text); } catch (e: any) {
        Logger.warn(`[input] scheduler submit failed: ${e?.message || e}`);
      }
    } else {
      Logger.debug("[input] background submit dropped (no scheduler submit bound)");
    }
  }

  private pickSubmitFn(s: any): { fn: SubmitFn | null; name: string | null } {
    // Allow override via env for experiments.
    const preferred = (R.env.ORG_SCHEDULER_SUBMIT || "").trim();
    if (preferred && typeof s?.[preferred] === "function") {
      return { fn: (t: string) => s[preferred](t), name: preferred };
    }

    // Known entry points across schedulers in this repo.
    const candidates = [
      "handleUserInterjection", // <- test doubles expect this
      "receiveUser",
      "interject",
      "submitUser",
      "submit",
      "enqueueUser",
      "onUserInput",
    ];
    for (const name of candidates) {
      if (typeof s?.[name] === "function") {
        return { fn: (t: string) => s[name](t), name };
      }
    }
    return { fn: null, name: null };
  }
}

/* -------------------------------------------------------------------------- */
/* Test helper: makeControllerForTests (keeps backward-compat API)
 * --------------------------------------------------------------------------
 * Returns an object exposing `_private.emitKey(...)` (as older tests expect)
 * and convenience helpers for feeding input and capturing output.
 */
export function makeControllerForTests(
  opts: InputControllerOptions & { scheduler?: any } = {},
): {
  ctrl: InputController;
  feed: (s: string | Buffer) => void;
  type: (s: string) => void;
  pressEsc: () => void;
  pressEnter: () => void;
  pressI: () => void;
  out: () => string;
  err: () => string;
  restore: () => void;
  _private: { emitKey: (ev: any) => void };
} {
  // Save originals to restore later
  const orig = { stdin: R.stdin, stdout: R.stdout, stderr: R.stderr };

  // Fake TTY streams
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  (stdin as any).isTTY = true;
  (stdin as any).isRaw = false;
  (stdin as any).setRawMode = function (v: boolean) { (stdin as any).isRaw = !!v; };

  let outBuf = "";
  let errBuf = "";
  stdout.on("data", (c) => { outBuf += c.toString("utf8"); });
  stderr.on("data", (c) => { errBuf += c.toString("utf8"); });

  // Patch runtime IO
  (R as any).stdin = stdin as any;
  (R as any).stdout = stdout as any;
  (R as any).stderr = stderr as any;

  const { scheduler, ...rest } = opts as any;
  const ctrl = new InputController(rest);
  if (scheduler) ctrl.attachScheduler(scheduler);

  const feed = (s: string | Buffer) => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8");
    stdin.write(b);
  };
  const type = (s: string) => feed(s);
  const pressEsc = () => feed(Buffer.from([0x1b]));
  const pressEnter = () => feed(Buffer.from([0x0d]));
  const pressI = () => feed((opts.interjectKey ?? "i"));

  const restore = () => {
    (R as any).stdin = orig.stdin;
    (R as any).stdout = orig.stdout;
    (R as any).stderr = orig.stderr;
  };

  // Back-compat path used by tests: allow direct key injection.
  const _private = {
    emitKey: (ev: any) => {
      try {
        // Route directly so tests get deterministic behavior.
        (ctrl as any).routeEvent(ev);
      } catch (e: any) {
        Logger.warn(`[input.test] emitKey failed: ${e?.message || e}`);
      }
    },
  };

  return {
    ctrl,
    feed,
    type,
    pressEsc,
    pressEnter,
    pressI,
    out: () => outBuf,
    err: () => errBuf,
    restore,
    _private,
  };
}
