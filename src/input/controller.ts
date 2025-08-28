// src/input/controller.ts
// Sole owner of TTY input in raw mode, driven by a small FSM.
//
// Goals of this revision:
//  - Make interjection ('i') reliable and immediate.
//  - Ensure the 'You: ' banner is printed on a clean line (no "…INFO" collisions).
//  - Mark UI as busy during the prompt so console output (heartbeats / fills) won't
//    trample the input line (best-effort via R.setUIBusy | R.uiBusy | R.UIBusy).
//  - Keep graceful ESC, fast Ctrl+C (real runs), Ctrl+Z suspend, and the test helper API.

import { R } from "../runtime/runtime";
import { Logger } from "../logger";
import { decodeKey } from "./keys";
import { InputFSM } from "./fsm";
import { PassThrough } from "stream";

type SubmitFn = (text: string) => any;

export interface InputControllerOptions {
  interjectKey?: string;          // default: 'i'
  interjectBanner?: string;       // default: 'You: '
  finalizer?: () => Promise<void> | void;
  exitOnEsc?: boolean;            // print trailing newline after finalize. default: true
  fastExitOnCtrlC?: boolean;      // default: true (real runs), false in tests
  suspendOnCtrlZ?: boolean;       // default: true (real runs), false in tests
}

export class InputController {
  private readonly opts: Required<InputControllerOptions>;

  private scheduler: any | null = null;
  private submitting: SubmitFn | null = null;
  private submittingName: string | null = null;

  private fsm: InputFSM;
  private rawWasOn = false;
  private keyDebug = false;

  // when an agent asks @@user a question
  private pendingResolve: ((s: string) => void) | null = null;

  // simple "are we at BOL?" tracking for newline hygiene
  private lastWriteEndedWithNewline = true;

  // ---- static hooks (used by tty-guard etc.) ----
  private static _active: InputController | null = null;
  static setRawMode(v: boolean) {
    const stdin: any = R.stdin as any;
    if (stdin?.isTTY && typeof stdin.setRawMode === "function") {
      try { stdin.setRawMode(v); } catch {}
      try { (stdin as any).isRaw = !!v; } catch {}
    }
  }
  static isRawMode(): boolean {
    try { return !!(R.stdin as any)?.isRaw; } catch { return false; }
  }
  static disableKeys() { this._active?._detachKeys(); }
  static enableKeys() { this._active?._attachKeys(); }

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

    // Track newline hygiene by wrapping stdout.write lightly.
    try {
      const out: any = R.stdout as any;
      const orig = out.write.bind(out);
      out.write = (chunk: any, ...rest: any[]) => {
        const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
        if (s.length) this.lastWriteEndedWithNewline = /\n$/.test(s);
        return orig(chunk, ...rest);
      };
    } catch { /* ignore */ }

    // Wire FSM to IO + hooks
    this.fsm = new InputFSM(
      {
        write: (s: string) => this.writeFromFSM(s),
        bell:  () => { try { R.stdout.write("\x07"); } catch {} },
      },
      {
        banner: this.opts.interjectBanner,
        interjectKey: this.opts.interjectKey,
        onSubmit: (text) => this.submitText(text),
        onCancel:  () => this.setUIBusy(false),     // leaving prompt
        onEscapeIdle: () => this.handleEscapeIdle(),
      }
    );

    InputController._active = this;
    this._attachKeys();

    // Re-arm raw mode after a foreground resume.
    try {
      R.on?.("SIGCONT", () => {
        Logger.debug("[input] SIGCONT -> re-enabling raw mode");
        this.enableRaw();
      });
    } catch { /* ignore */ }
  }

  attachScheduler(s: any) {
    this.scheduler = s;
    const pick = this.pickSubmitFn(s);
    this.submitting = pick.fn;
    this.submittingName = pick.name;
    if (pick.name) Logger.debug(`[input] bound scheduler submit: ${pick.name}`);
    else Logger.warn("[input] no scheduler submit function found");
  }

  // Used by scheduler when an agent explicitly asks @@user.
  // IMPORTANT: do NOT echo 'content' here — the UI already prints it.
  async askUser(_fromAgent: string, _content: string): Promise<string> {
    return await this.promptOnce();
  }

  // Kickoff helper: true => prompt; string => background submit
  async askInitialAndSend(kickoff?: string | boolean) {
    if (kickoff === true) {
      await this.promptOnce();
    } else if (typeof kickoff === "string" && kickoff.length > 0) {
      this.submitText(kickoff);
    }
  }

  // ---------------- internal wiring ----------------

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

    // ESC (single byte) when idle -> graceful stop
    if (s === "\x1B" && !this.pendingResolve) {
      Logger.debug("[input] ESC (idle) -> graceful stop");
      void this.handleEscapeIdle();
      return;
    }

    // Decode normally
    const ev = decodeKey(chunk);
    if (this.keyDebug) {
      try { R.stderr.write(`[key] ${JSON.stringify(ev)}\n`); } catch {}
    }

    // Interjection hotkey: open immediately, not mid-stream messy
    if (ev && ev.type === "char" && ev.data === this.opts.interjectKey && !this.pendingResolve) {
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

  private async handleEscapeIdle() {
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
        this.lastWriteEndedWithNewline = true;
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
        this.setUIBusy(false); // leaving prompt
        resolve(out);
      };
      // Open prompt immediately here (explicit ask by agent).
      this.openInterjectNow();
    });
  }

  private submitText(t: string) {
    const text = String(t ?? "");
    const hadPrompt = !!this.pendingResolve;

    if (hadPrompt) {
      const resolve = this.pendingResolve; this.pendingResolve = null;
      try { resolve!(text); } catch {}
      // do NOT also forward to scheduler
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

  // --- helpers ---------------------------------------------------------------

  private setUIBusy(b: boolean) {
    try {
      const anyR = R as any;
      if (typeof anyR.setUIBusy === "function") { anyR.setUIBusy(b); return; }
      if ("uiBusy" in anyR) { anyR.uiBusy = b; return; }
      (anyR as any).UIBusy = b; // best-effort
    } catch { /* ignore */ }
  }

  private openInterjectNow() {
    // Mark UI busy so heartbeat/fills won't clobber the prompt.
    this.setUIBusy(true);

    // Make sure the banner starts on a fresh line (avoid trailing '...INFO')
    if (!this.lastWriteEndedWithNewline) {
      try { R.stdout.write("\n"); } catch {}
      this.lastWriteEndedWithNewline = true;
    }

    // Drive FSM as if user hit the configured hotkey.
    this.fsm.handle({ type: "char", data: this.opts.interjectKey });
  }

  private writeFromFSM(s: string) {
    // If the FSM is printing the banner, force a newline first.
    const isBanner = s === this.opts.interjectBanner || s.endsWith(this.opts.interjectBanner);
    if (isBanner && !this.lastWriteEndedWithNewline) {
      try { R.stdout.write("\n"); } catch {}
      this.lastWriteEndedWithNewline = true;
    }
    try { R.stdout.write(s); } catch {}
    // Maintain newline hygiene for subsequent writes
    if (s.length) this.lastWriteEndedWithNewline = /\n$/.test(s);
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
}

/* -------------------------------------------------------------------------- */
/* Test helper: makeControllerForTests (back-compat)                          */
/* -------------------------------------------------------------------------- */
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
  const orig = { stdin: R.stdin, stdout: R.stdout, stderr: R.stderr };

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

  (R as any).stdin = stdin as any;
  (R as any).stdout = stdout as any;
  (R as any).stderr = stderr as any;

  const { scheduler, ...rest } = opts as any;
  const ctrl = new InputController({
    ...rest,
    fastExitOnCtrlC: false, // tests must not exit
    suspendOnCtrlZ: false,
  });
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

  const _private = {
    emitKey: (ev: any) => {
      try {
        (ctrl as any).onData?.(
          typeof ev === "string" ? Buffer.from(ev, "utf8")
          : ev?.name === "escape" ? Buffer.from([0x1b])
          : (ev?.name === "c" && ev?.ctrl) ? Buffer.from([0x03])
          : (ev?.name === "z" && ev?.ctrl) ? Buffer.from([0x1a])
          : Buffer.from([])
        );
        if (ev && typeof ev === "object" && !ev.length) {
          (ctrl as any).fsm?.handle(ev);
        }
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
