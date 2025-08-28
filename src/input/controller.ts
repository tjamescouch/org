// src/input/controller.ts
// Single owner of stdin in raw mode, built on a tiny FSM.
// Public API kept compatible with existing app.ts usage.

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
}

export class InputController {
  private opts: Required<InputControllerOptions>;
  private scheduler: any | null = null;
  private submitting: SubmitFn | null = null; // dynamic submit method on scheduler
  private fsm: InputFSM;
  private rawWasOn = false;
  private keyDebug = false;

  constructor(opts: InputControllerOptions = {}) {
    this.opts = {
      interjectKey: opts.interjectKey ?? "i",
      interjectBanner: opts.interjectBanner ?? "You: ",
      finalizer: opts.finalizer ?? (() => {}),
      exitOnEsc: opts.exitOnEsc ?? true,
    };

    this.keyDebug = (R.env.ORG_KEY_DEBUG === "1" || R.env.DEBUG === "1");

    // FSM IO adapter
    this.fsm = new InputFSM(
      {
        write: (s: string) => { R.stdout.write(s); },
        bell: () => { R.stdout.write("\x07"); },
      },
      {
        banner: this.opts.interjectBanner,
        interjectKey: this.opts.interjectKey,
        onSubmit: (text) => this.submitText(text),
        onCancel: () => { /* no-op; we just return to idle */ },
        onEscapeIdle: () => { this.handleEscapeIdle(); },
      }
    );

    // Become the SOLE owner of stdin
    this.enableRaw();
    R.stdin.on("data", this.onData);
    // Ensure we clean up on exit signals
    const restore = () => this.disableRaw();
    R.on("exit", restore);
    R.on("beforeExit", restore);
  }

  attachScheduler(s: any) {
    this.scheduler = s;
    this.submitting = this.pickSubmitFn(s);
  }

  // Used by scheduler via onAskUser hook
  async askUser(_fromAgent: string, content: string): Promise<string> {
    // Print the agent's message; then open interject and wait
    if (content && content.length) {
      R.stdout.write(content.endsWith("\n") ? content : content + "\n");
    }
    return await this.promptOnce();
  }

  // Kickoff asking: - true = ask user, string = seed text to scheduler
  async askInitialAndSend(kickoff?: string | boolean) {
    if (kickoff === true) {
      await this.promptOnce();
    } else if (typeof kickoff === "string" && kickoff.length > 0) {
      this.submitText(kickoff);
    }
  }

  // ---- internal ----

  private onData = (chunk: Buffer) => {
    const ev = decodeKey(chunk);
    if (this.keyDebug) {
      try { R.stderr.write(`[key] ${JSON.stringify(ev)}\n`); } catch { /* ignore */ }
    }
    this.fsm.handle(ev);
  };

  private enableRaw() {
    const stdin: any = R.stdin as any;
    if (stdin.isTTY) {
      this.rawWasOn = !!stdin.isRaw;
      if (!stdin.isRaw && typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    }
    R.stdin.resume();
  }

  private disableRaw() {
    const stdin: any = R.stdin as any;
    if (stdin.isTTY && !this.rawWasOn && typeof stdin.setRawMode === "function") {
      try { stdin.setRawMode(false); } catch { /* ignore */ }
    }
  }

  private async handleEscapeIdle() {
    try {
      await this.opts.finalizer();
    } catch (e: any) {
      Logger.warn("finalizer error:", e?.message || String(e));
    }
    if (this.opts.exitOnEsc) {
      // Let app.ts decide exact code; we just end the loop.
      R.stdout.write("\n");
    }
  }

  private pendingResolve: ((s: string) => void) | null = null;

  private async promptOnce(): Promise<string> {
    if (this.pendingResolve) {
      // Already prompting; bail out to avoid re-entrancy.
      return new Promise<string>((resolve) => {
        const prev = this.pendingResolve!;
        this.pendingResolve = (s: string) => { prev(s); resolve(s); };
      });
    }
    return await new Promise<string>((resolve) => {
      this.pendingResolve = resolve;
      this.fsm.beginInterject();
    });
  }

  private submitText(text: string) {
    const t = String(text ?? "").trimEnd();
    if (this.pendingResolve) {
      const resolve = this.pendingResolve; this.pendingResolve = null;
      resolve(t);
    }
    // Also send to scheduler if available (background submit)
    if (t && this.scheduler && this.submitting) {
      try {
        this.submitting(t);
      } catch (e: any) {
        Logger.warn("scheduler submit failed:", e?.message || String(e));
      }
    }
  }

  private pickSubmitFn(s: any): SubmitFn | null {
    // Respect override; else best-effort probing (back-compat)
    const preferred = (R.env.ORG_SCHEDULER_SUBMIT || "receiveUser").trim();
    if (typeof s?.[preferred] === "function") return (t: string) => s[preferred](t);

    const candidates = [
      "receiveUser", "submitUser", "submit", "enqueueUser", "onUserInput",
    ];
    for (const name of candidates) {
      if (typeof s?.[name] === "function") return (t: string) => s[name](t);
    }
    Logger.warn("[input] no scheduler submit function found");
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Test helper: makeControllerForTests                                        */
/* -------------------------------------------------------------------------- */

/**
 * Creates an InputController wired to fake TTY streams.
 * Tests can feed raw key bytes and capture what the app writes.
 *
 * Usage (typical):
 *   const t = makeControllerForTests({ interjectKey: "i" });
 *   t.feed("ihello\r");       // type "hello" after opening interject
 *   t.feed("\x1b");           // ESC
 *   t.restore();
 */
export function makeControllerForTests(
  opts: InputControllerOptions = {},
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
} {
  // Save originals
  const orig = { stdin: R.stdin, stdout: R.stdout, stderr: R.stderr };

  // Create fake TTYs
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // Mark them as TTY + provide setRawMode
  Object.assign(stdin as any, {
    isTTY: true,
    isRaw: false,
    setRawMode: function (v: boolean) { (stdin as any).isRaw = !!v; },
    resume: () => {},
    pause: () => {},
  });
  Object.assign(stdout as any, { isTTY: true });
  Object.assign(stderr as any, { isTTY: true });

  // Capture written data
  let outBuf = "";
  let errBuf = "";
  stdout.on("data", (c) => { outBuf += c.toString("utf8"); });
  stderr.on("data", (c) => { errBuf += c.toString("utf8"); });

  // Patch R for the duration of the test controller
  (R as any).stdin = stdin as any;
  (R as any).stdout = stdout as any;
  (R as any).stderr = stderr as any;

  const ctrl = new InputController(opts);

  const feed = (s: string | Buffer) => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8");
    stdin.write(b);
  };
  const type = (s: string) => feed(s);
  const pressEsc = () => feed(Buffer.from([0x1b]));
  const pressEnter = () => feed(Buffer.from([0x0d]));
  const pressI = () => feed("i");

  const restore = () => {
    (R as any).stdin = orig.stdin;
    (R as any).stdout = orig.stdout;
    (R as any).stderr = orig.stderr;
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
  };
}
