// src/input/controller.ts
// Sole owner of TTY input in raw mode, driven by a small FSM.
//
// Focused change: remove the ugly right-edge `... INFO` lines.
// We wrap stdout.write and DROP any line that is purely filler + `INFO`
// (optionally starting with "You:"). Everything else passes through.
//
// Preserved: ESC finalize (once), interject hotkey, Ctrl+C fast exit in real runs,
// Ctrl+Z suspend with raw-mode rearm, no double-delivery of user input.

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
  exitOnEsc?: boolean;            // default: true
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

  private pendingResolve: ((s: string) => void) | null = null;

  // ESC once guard
  private escInProgress = false;

  // --- constructor -----------------------------------------------------------
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

    // Install a very narrow stdout filter: drop "filler + INFO" lines.
    this.installRightInfoFilter();

    // Wire FSM
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

  // --- public API ------------------------------------------------------------
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

  // --- stdin wiring ----------------------------------------------------------
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

  // --- behaviors -------------------------------------------------------------
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
        this.setUIBusy(false);      // leave prompt
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

  // --- helpers ---------------------------------------------------------------
  private setUIBusy(b: boolean) {
    try {
      const anyR = R as any;
      if (typeof anyR.setUIBusy === "function") { anyR.setUIBusy(b); return; }
      if ("uiBusy" in anyR) { anyR.uiBusy = b; return; }
      (anyR as any).UIBusy = b;
    } catch { /* ignore */ }
  }

  private openInterjectNow() {
    this.setUIBusy(true);                 // pause dotted fills
    // Clean line: CR + clear-to-EOL
    try { R.stdout.write("\r\x1b[K"); } catch {}
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

  // --- stdout filter ---------------------------------------------------------
  private installRightInfoFilter() {
    try {
      const out: any = R.stdout as any;
      const orig = out.write.bind(out);

      out.write = (chunk: any, ...rest: any[]) => {
        try {
          const s =
            typeof chunk === "string"
              ? chunk
              : Buffer.isBuffer(chunk)
              ? chunk.toString("utf8")
              : String(chunk ?? "");

          if (s.indexOf("\n") === -1) {
            // no newline -> pass through (avoid buffering streaming tokens)
            return orig(chunk, ...rest);
          }

          // Process line-by-line and drop only pure filler+INFO lines.
          let changed = false;
          const parts = s.split(/\n/);
          for (let i = 0; i < parts.length - 1; i++) { // full lines
            const line = parts[i];
            const stripped = stripAnsi(line);
            if (isRightEdgeInfoFiller(stripped)) {
              parts[i] = ""; // drop line
              changed = true;
            }
          }
          const rebuilt = parts.join("\n");
          if (changed) {
            return orig(rebuilt, ...rest);
          }
        } catch {
          // fall through
        }
        return orig(chunk, ...rest);
      };
    } catch { /* ignore */ }
  }
}

// Normalize interject hotkey detection across decodeKey shapes.
function isInterjectHotkey(ev: any, key: string): boolean {
  if (!ev) return false;
  if (ev.type === "char" && ev.data === key) return true;
  if (ev.name === key && !ev.ctrl && !ev.meta) return true;
  if (ev.key && ev.key.name === key && !ev.key.ctrl && !ev.key.meta) return true;
  return false;
}

// --- helpers for the stdout filter ------------------------------------------

/** Strip ANSI SGR/control sequences. */
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Return true if the *entire* line is just filler + "INFO" (optionally "You:" prefix).
 * Examples that will be dropped:
 *   "........................................INFO"
 *   "You: ................................. INFO"
 *   "                                     INFO"
 */
function isRightEdgeInfoFiller(strippedLine: string): boolean {
  const line = strippedLine.trimEnd(); // keep left spaces
  if (!line.endsWith("INFO")) return false;
  const body = line.slice(0, -4); // remove trailing "INFO"
  const noYou = body.replace(/^You:\s*/i, "");
  // purely filler (dots/spaces/box-drawing etc.)?
  return /^[.\s•·\u2500-\u257F\u2591-\u2593_\-\\|]*$/.test(noYou);
}

/* -------------------------------------------------------------------------- */
/* Test helper: makeControllerForTests (back-compat)                           */
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
