// src/input/tty-controller.ts
// TTY controller (single stdin owner) with immediate ESC/`i` feedback to stderr.
// - ESC: always initiates graceful shutdown (waits for stream end, then review).
// - 'i': interject only when interactive; queued if pressed during streaming.
// - Feedback goes to stderr so it's never blocked by stdout token flow.
// - Public API preserved.

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";
import { Logger } from "../logger";

/* ----------------------------- Types & adapters ----------------------------- */

export type TtyMode = "raw" | "cooked";
export type TtyIn = Pick<NodeJS.ReadStream, "isTTY" | "on" | "off"> &
  Partial<Pick<NodeJS.ReadStream, "setRawMode" | "isRaw" | "resume">>;

function hasSetRawMode(s: NodeJS.ReadStream): s is TtyReadStream {
  return typeof (s as { setRawMode?: unknown }).setRawMode === "function";
}
function hasIsRaw(s: NodeJS.ReadStream): s is TtyReadStream & { isRaw: boolean } {
  return typeof (s as { isRaw?: unknown }).isRaw === "boolean";
}
export function toTtyIn(stream: NodeJS.ReadStream): TtyIn {
  const base: TtyIn = {
    isTTY: stream.isTTY === true,
    on: stream.on.bind(stream),
    off: (stream as any).off?.bind(stream) ?? ((ev: string, fn: any) => (stream as any).removeListener?.(ev, fn))
  };
  if (hasIsRaw(stream)) base.isRaw = stream.isRaw;
  if (hasSetRawMode(stream)) base.setRawMode = (stream as TtyReadStream).setRawMode.bind(stream as TtyReadStream);
  (base as any).resume = (stream as any).resume?.bind(stream);
  return base;
}

/* --------------------------------- Options --------------------------------- */

export interface TtyControllerOptions {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;

  /** Idle prompt label (e.g., "user: "). A trailing space is enforced. */
  prompt: string;

  /** Interjection key (default 'i'). */
  interjectKey: string;

  /** Interjection prompt label (e.g., "user: "). A trailing space is enforced. */
  interjectBanner: string;

  /** Where to print fast feedback; defaults to stderr. */
  feedbackStream?: NodeJS.WriteStream;

  /** UX hint when deferring on ESC. */
  waitOverlayMessage?: string;

  /** Called on graceful unwind (signals/ESC). */
  finalizer?: () => Promise<void> | void;

  /** Who owns idle loop? (We keep for API parity; you use "external".) */
  loopMode?: "controller" | "external";
}

/* ------------------------------- Controller -------------------------------- */

export class TtyController {
  private readonly loopMode: "controller" | "external";
  private scheduler: IScheduler | undefined;

  private running = false;
  private reading = false;
  private interjecting = false;
  private keyBound = false;

  private streaming = false;
  private shutdownRequested = false;
  private interjectPending = false;
  private reviewInFlight = false;

  private readonly feedback: NodeJS.WriteStream;

  constructor(private readonly opts: TtyControllerOptions) {
    if (!this.opts.prompt.endsWith(" ")) this.opts.prompt += " ";
    if (!this.opts.interjectBanner.endsWith(" ")) this.opts.interjectBanner += " ";
    this.loopMode = opts.loopMode ?? "controller";
    this.feedback = opts.feedbackStream ?? process.stderr;
  }

  /* ------------------------------ Public API ------------------------------ */

  setScheduler(s: IScheduler): void { this.scheduler = s; }

  /** Bind raw mode and key handlers; spawn the idle loop only if loopMode="controller". */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    emitKeypressEvents(this.opts.stdin);
    try { (this.opts.stdin as any).setRawMode?.(true); } catch { /* ignore */ }
    try { (this.opts.stdin as any).resume?.(); } catch { /* ignore */ }

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
    try { (this.opts.stdin as any).setRawMode?.(false); } catch { /* ignore */ }
    await Promise.resolve(this.opts.finalizer?.());
  }

  /** Allow an external owner (e.g., scheduler) to read one line with our prompt. */
  async readUserLine(label?: string): Promise<string> {
    return this.promptOnce(label ?? this.opts.prompt);
  }

  /** Agent asks the user for input; we print the content then prompt once. */
  async askUser(_fromAgent: string, _content: string): Promise<string | undefined> {
    const ans = await this.promptOnce(this.opts.interjectBanner);
    return ans.trim() === "" ? undefined : ans;
  }

  /** Raw passthroughs kept for API parity. */
  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return await Promise.resolve(fn()); }
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return await Promise.resolve(fn()); }

  /** Called by the scheduler when the model starts/finishes emitting tokens. */
  onStreamStart(): void { this.streaming = true; }
  async onStreamEnd(): Promise<void> {
    this.streaming = false;
    if (this.shutdownRequested) {
      this.shutdownRequested = false;
      await this.finalizeAndReviewAndExit();
      return;
    }
    if (this.interjectPending) {
      this.interjectPending = false;
      await this.openInterjectionPromptOnce();
    }
  }

  /* ------------------------------- Internals ------------------------------- */

  private onKeypress = async (_: string, key: Key) => {
    // Ctrl+C -> immediate
    if ((key.ctrl && key.name === "c") || key.sequence === "\x03") {
      this.statusLine("SIGINT");
      process.exit(130);
      return;
    }

    // ESC -> graceful
    if (key.name === "escape" || key.sequence === "\u001b") {
      if (this.streaming) {
        this.shutdownRequested = true;
        this.statusLine(this.opts.waitOverlayMessage ??
          "⏳ ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)");
        return;
      }
      await this.finalizeAndReviewAndExit();
      return;
    }

    // Interjection (interactive only)
    if (key.name === (this.opts.interjectKey || "i")) {
      if (this.reading || this.interjecting) return;
      if (this.streaming) {
        this.interjectPending = true;
        this.statusLine("…waiting for model to finish before interjection");
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
      if (text.trim().length > 0) await this.scheduler?.enqueueUserText(text);
    } finally {
      this.interjecting = false;
    }
  }

  private async finalizeAndReviewAndExit(): Promise<void> {
    if (this.reviewInFlight) return;
    this.reviewInFlight = true;
    try {
      await this.unwind();
      process.exit(0);
    } catch (err) {
      Logger.warn(`Finalize/review failed: ${String(err)}`);
      try { await this.unwind(); } catch { /* ignore */ }
      process.exit(1);
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
    try { this.feedback.write(`\n${msg}\n`); } catch { /* ignore */ }
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

const _default = new TtyController({
  stdin: process.stdin,
  stdout: process.stdout,
  prompt: "user: ",
  interjectKey: "i",
  interjectBanner: "user: ",
  feedbackStream: process.stderr,
});

export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withCookedTTY(fn); }
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withRawTTY(fn); }
export async function unwind(): Promise<void> { return _default.unwind(); }

// Optional compatibility: some older code stores a scheduler here.
let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }
