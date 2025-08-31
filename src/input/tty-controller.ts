// src/input/tty-controller.ts
// TTY controller (runtime-owned) with robust, portable hotkeys.
// - Single stdin owner; keypress-based ESC/'i' handling (works in Bun/Node)
// - ESC: always graceful (defer to stream end, then review), only when interactive
// - 'i': interject only when interactive; queued if pressed during streaming
// - Immediate feedback to stderr so it never competes with token stream
// - start() exported and made compatible with existing `await ttyStart()` usage by
//   proxying to R.ttyController if present (zero changes needed in app.ts)

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";
import { Logger } from "../logger";
import { R } from "../runtime/runtime";

/* ----------------------------- Types & helpers ----------------------------- */

export type TtyMode = "raw" | "cooked";

export interface TtyControllerOptions {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;

  /** Idle prompt label (e.g., "user: "). A trailing space is enforced. */
  prompt: string;

  /** Interjection key (default 'i'). */
  interjectKey: string;

  /** Interjection prompt label (e.g., "user: "). A trailing space is enforced. */
  interjectBanner: string;

  /** UX hint when deferring on ESC (printed once to stderr). */
  waitOverlayMessage?: string;

  /** Called on graceful unwind (signals/ESC). Should perform stop→drain→review. */
  finalizer?: () => Promise<void> | void;

  /**
   * Who owns the idle user loop?
   *  - "controller": this class runs the idle loop.
   *  - "external": caller (e.g., scheduler) drives the loop via readUserLine().
   */
  loopMode?: "controller" | "external";

  /** Where to print hotkey feedback. Defaults to stderr. */
  feedbackStream?: NodeJS.WriteStream;
}

function hasSetRawMode(s: NodeJS.ReadStream): s is TtyReadStream {
  return typeof (s as { setRawMode?: unknown }).setRawMode === "function";
}

/* -------------------------------- Controller ------------------------------- */

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

  /** Bind raw mode + key handlers. Only binds when stdin is a TTY. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (!this.opts.stdin.isTTY) {
      // Non-interactive: do not attach hotkeys; prompts will still work when called.
      Logger.debug?.("[tty] stdin is not a TTY; hotkeys disabled");
      return;
    }

    try { emitKeypressEvents(this.opts.stdin); } catch { /* ignore */ }
    try { hasSetRawMode(this.opts.stdin) && this.opts.stdin.setRawMode!(true); } catch { /* ignore */ }
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
    if (this.keyBound && this.opts.stdin.isTTY) {
      try { this.opts.stdin.off("keypress", this.onKeypress); } catch { /* ignore */ }
      this.keyBound = false;
    }
    if (this.opts.stdin.isTTY && hasSetRawMode(this.opts.stdin)) {
      try { this.opts.stdin.setRawMode!(false); } catch { /* ignore */ }
    }
    await Promise.resolve(this.opts.finalizer?.());
  }

  /** External owner (e.g., scheduler) asks for exactly one user line. */
  async readUserLine(label?: string): Promise<string> {
    return this.promptOnce(label ?? this.opts.prompt);
  }

  /** Agent asks for input; we prompt once with interject banner. */
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
    if (!this.opts.stdin.isTTY) return; // hotkeys disabled in non-interactive

    // Ctrl+C -> immediate exit
    if ((key.ctrl && key.name === "c") || key.sequence === "\x03") {
      try { this.statusLine("SIGINT"); } finally { process.exit(130); }
      return;
    }

    // ESC -> graceful finalize (defer if streaming)
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

    // 'i' -> interject (interactive only). Ignore while already prompting.
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
      await this.unwind();     // runs your finalizer (stop→drain→review)
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
/* To keep legacy `await ttyStart()` working with a runtime-owned controller. */

const _default = new TtyController({
  stdin: process.stdin,
  stdout: process.stdout,
  prompt: "user: ",
  interjectKey: "i",
  interjectBanner: "user: ",
  feedbackStream: process.stderr,
});

/** Start the runtime-owned controller if present; otherwise start the module default. */
export async function start(): Promise<void> {
  const ctl = (R as any)?.ttyController as TtyController | undefined;
  if (ctl) return ctl.start();
  return _default.start();
}

export async function unwind(): Promise<void> {
  const ctl = (R as any)?.ttyController as TtyController | undefined;
  if (ctl) return ctl.unwind();
  return _default.unwind();
}

export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withCookedTTY(fn); }
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withRawTTY(fn); }

// Optional compatibility (no-op storage; some older code pokes here).
let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }
