// src/input/tty-controller.ts
// Stable TTY controller with minimal, safe additions:
// - ESC deferral: if pressed while streaming, wait for stream end then finalize+review+exit.
// - 'i' interjection: only in interactive mode; if streaming, queue and open right after stream.
// - Immediate visual feedback lines on Esc/'i'.
// - Public API preserved; defaults to your previously working readline behavior.

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";
import { Logger } from "../logger";
import { R } from "../runtime/runtime";

/* ----------------------------- Types & adapters ----------------------------- */

export type TtyMode = "raw" | "cooked";

export type TtyIn = Pick<NodeJS.ReadStream, "isTTY"> &
  Partial<Pick<NodeJS.ReadStream, "setRawMode" | "isRaw">>;

function hasSetRawMode(s: NodeJS.ReadStream): s is TtyReadStream {
  return typeof (s as { setRawMode?: unknown }).setRawMode === "function";
}
function hasIsRaw(s: NodeJS.ReadStream): s is TtyReadStream & { isRaw: boolean } {
  return typeof (s as { isRaw?: unknown }).isRaw === "boolean";
}

export function toTtyIn(stream: NodeJS.ReadStream): TtyIn {
  const base: TtyIn = { isTTY: stream.isTTY === true };
  if (hasIsRaw(stream)) base.isRaw = stream.isRaw;
  if (hasSetRawMode(stream)) base.setRawMode = (stream as TtyReadStream).setRawMode.bind(stream as TtyReadStream);
  return base;
}

export function stdinTty(): TtyIn { return toTtyIn(R.stdin); }

/* ------------------------------- Mode manager ------------------------------- */

class ModeController {
  private current: TtyMode;

  constructor(private readonly tty: TtyIn) {
    this.current = !tty.isTTY ? "cooked" : tty.isRaw ? "raw" : "cooked";
  }

  get mode(): TtyMode { return this.current; }

  /** Force raw for the lifetime of the controller to avoid OS echo duplication. */
  forceRaw(): void {
    if (this.tty.isTTY && this.tty.setRawMode) {
      this.tty.setRawMode(true);
      this.current = "raw";
    }
  }

  /** Best-effort return to cooked on unwind. */
  toCooked(): void {
    if (this.tty.isTTY && this.tty.setRawMode) {
      this.tty.setRawMode(false);
      this.current = "cooked";
    }
  }

  isInteractive(): boolean {
    return this.tty.isTTY === true;
  }
}

/* --------------------------------- Options --------------------------------- */

export interface TtyControllerOptions {
  feedbackStream?: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;

  /** Idle prompt label (e.g., "user: "). A trailing space is enforced. */
  prompt: string;

  /** Interjection key (default 'i'). */
  interjectKey: string;

  /** Interjection prompt label (e.g., "user: "). A trailing space is enforced. */
  interjectBanner: string;

  /** Optional UX hint line when deferring on ESC. */
  waitOverlayMessage?: string;
  waitSuppressOutput?: boolean;

  /** Called on graceful unwind (signals/exits). Should run: stop → drain → review/pager. */
  finalizer?: () => Promise<void> | void;

  beginFeedback?: (msg: string) => { done: () => void };

  /**
   * Who owns the idle user loop?
   *  - "controller": this class runs the idle loop (default).
   *  - "external": caller (e.g., the scheduler) drives the loop via readUserLine().
   */
  loopMode?: "controller" | "external";
}

/* ------------------------------- Controller -------------------------------- */

export class TtyController {
  private readonly mode: ModeController;
  private readonly loopMode: "controller" | "external";
  private scheduler: IScheduler | undefined;
  private running = false;
  private reading = false;
  private interjecting = false;
  private keyBound = false;

  private activeFeedback: { done: () => void } | null = null;

  // Streaming/intent flags (PR-safe additions)
  private streaming = false;            // true while model is "chattering"
  private shutdownRequested = false;    // ESC pressed during streaming -> defer finalize
  private interjectPending = false;     // 'i' pressed during streaming -> open after stream
  private reviewInFlight = false;       // avoid double finalize
  private statusShown = { esc: false, i: false };
  private feedback = R.stderr;

  constructor(private readonly opts: TtyControllerOptions) {
    if (!this.opts.prompt.endsWith(" ")) this.opts.prompt += " ";
    if (!this.opts.interjectBanner.endsWith(" ")) this.opts.interjectBanner += " ";
    this.mode = new ModeController(toTtyIn(opts.stdin));
    this.loopMode = opts.loopMode ?? "controller";
    this.feedback = this.opts.feedbackStream ?? this.feedback;
  }

  /* ------------------------------ Public API ------------------------------ */

  setScheduler(s: IScheduler): void { this.scheduler = s; }

  /** Bind raw mode and key handlers; spawn the idle loop only if loopMode="controller". */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    emitKeypressEvents(this.opts.stdin);
    this.mode.forceRaw();
    if (!this.keyBound) {
      this.keyBound = true;
      this.opts.stdin.on("keypress", this.onKeypress);
    }

    if (this.loopMode === "controller") {
      void this.readLoop();
    }
  }

  /** Gracefully tear down key handlers, restore cooked mode, and call finalizer. */
  async unwind(): Promise<void> {
    this.running = false;
    if (this.keyBound) {
      this.opts.stdin.off("keypress", this.onKeypress);
      this.keyBound = false;
    }
    this.mode.toCooked();
    await Promise.resolve(this.opts.finalizer?.());
  }

  /** Allow an external owner (e.g., scheduler) to read one line with our prompt/TTY rules. */
  async readUserLine(label?: string): Promise<string> {
    return this.promptOnce(label ?? this.opts.prompt);
  }

  /** Agent asks the user for input; we print the content then prompt once. */
  async askUser(_fromAgent: string, _content: string): Promise<string | undefined> {
    const ans = await this.promptOnce(this.opts.interjectBanner);
    return ans.trim() === "" ? undefined : ans;
  }

  /** Scoped helpers left as pass-through; readline handles cooked behavior under raw. */
  withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return Promise.resolve(fn()); }
  withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return Promise.resolve(fn()); }

  /** Streaming hooks (call from your scheduler/model driver). */
  onStreamStart(): void {
    this.streaming = true;
    this.statusShown.esc = false;
    this.statusShown.i = false;
  }

  async onStreamEnd(): Promise<void> {
    this.streaming = false;

    const fb = this.activeFeedback;
    this.activeFeedback = null;

    if (this.shutdownRequested) {
      this.shutdownRequested = false;
      fb?.done();                   // resume logs before pager
      await this.finalizeAndReviewAndExit();
      return;
    }
    if (this.interjectPending) {
      this.interjectPending = false;
      fb?.done();                   // resume logs before prompt
      await this.openInterjectionPromptOnce();
      return;
    }
  }

  /* ------------------------------- Internals ------------------------------- */

  private onKeypress = async (_: string, key: Key) => {
    // Esc → graceful exit path (always active)
    if (key.name === "escape" || key.sequence === "\u001b") {
      if (this.streaming) {
        if (!this.shutdownRequested) {
          this.shutdownRequested = true;
          // pause stream + show status instantly (newline + message + spinner if you want)
          this.activeFeedback ??= this.opts.beginFeedback?.(
            "⏳ ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)"
          ) ?? null;
        }

        return; // defer finalize to onStreamEnd()
      }
      // idle: give immediate feedback then finalize
      const fb = this.opts.beginFeedback?.("⏳ ESC pressed — opening patch review…");
      await this.finalizeAndReviewAndExit();
      fb?.done();

      return;
    }

    // Interject only when interactive
    if (key.name === (this.opts.interjectKey || "i")) {
      if (!this.mode.isInteractive()) return;

      // If currently prompting/opening an interjection, ignore repeat presses
      if (this.reading || this.interjecting) return;

      if (this.streaming) {
        if (!this.interjectPending) {
          this.interjectPending = true;
          this.activeFeedback ??= this.opts.beginFeedback?.(
            "…waiting for model to finish before interjection"
          ) ?? null;
        }

        return;
      }

      await this.openInterjectionPromptOnce();

      return;
    }
  };

  private async openInterjectionPromptOnce(): Promise<void> {
    if (this.interjecting) return;
    this.interjecting = true;
    try {
      const text = await this.promptOnce(this.opts.interjectBanner);
      if (text.trim().length > 0) {
        await this.scheduler?.enqueueUserText(text);
      }
    } finally {
      this.interjecting = false;
    }
  }

  private async finalizeAndReviewAndExit(): Promise<void> {
    if (this.reviewInFlight) return;
    this.reviewInFlight = true;
    try {
      await this.unwind();     // will run your finalizer (stop → drain → review/pager)
      R.exit(0);
    } catch (err) {
      Logger.warn(`Finalize/review failed: ${String(err)}`);
      try { await this.unwind(); } catch { /* ignore */ }
      R.exit(1);
    } finally {
      this.reviewInFlight = false;
    }
  }

  private async promptOnce(label: string): Promise<string> {
    this.reading = true;
    try {
      const rl = createInterface({ input: this.opts.stdin, output: this.opts.stdout, terminal: true });
      try {
        return await rl.question(label);
      } finally {
        rl.close();
      }
    } finally {
      this.reading = false;
    }
  }

  private statusLine(msg: string): void {
    try {
      // stderr avoids contention with token stream on stdout
      this.feedback.write(`\n${msg}\n`);
    } catch {/* ignore */ }
  }

  /** Default idle loop (only when loopMode === "controller"). */
  private async readLoop(): Promise<void> {
    while (this.running) {
      const line = await this.promptOnce(this.opts.prompt);
      const txt = line.trim();
      if (txt.length === 0) continue;
      await this.scheduler?.enqueueUserText(txt);
    }
  }
}

/* ------------------------- Module-level convenience ------------------------- */
/* Kept for compatibility with any legacy imports. Prefer the runtime-owned instance. */


export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return R.ttyController!.withCookedTTY(fn); }
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return R.ttyController!.withRawTTY(fn); }

// Optional compatibility: some older code stores a scheduler here.
let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }
