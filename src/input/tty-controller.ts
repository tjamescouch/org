// src/input/tty-controller.ts
// PR2: Wire EscInterjectController into the interactive TTY flow.
// - ESC: always graceful shutdown => wait for model stream to end, then finalize + patch review.
// - 'i': only in interactive mode; if streaming, queue interjection and show a one-line status.
// - Single owner for stdin in raw mode; cooked prompts are scoped and restore raw mode on exit.

import { createInterface as createRlInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream, WriteStream as TtyWriteStream } from "node:tty";

import { Logger } from "../logger";
import { EscInterjectController, RunPhase, type ReviewOpener, type InterjectionOpener } from "./esc-interject-controller";

// Optional scheduler type (we only use the parts we can detect safely via type guards)
export interface ISchedulerLike {
  enqueueUserText?(text: string): Promise<void> | void;
  // If present, should perform: sandbox finalize -> emit session.patch -> pager + confirm
  finalizeAndReview?(): Promise<void> | Promise<{ patchProduced: boolean }>;
  // Optional streaming hooks; we don't require them here
}

type Options = {
  stdin: TtyReadStream | NodeJS.ReadStream;
  stdout: TtyWriteStream | NodeJS.WriteStream;
  prompt: string;               // label for cooked prompts, e.g., "user: "
  interjectKey?: string;        // default: "i"
  interjectBanner?: string;     // default: same as prompt
};

export class TtyController {
  private readonly stdin: TtyReadStream | NodeJS.ReadStream;
  private readonly stdout: TtyWriteStream | NodeJS.WriteStream;

  private readonly promptLabel: string;
  private readonly interjectKey: string;
  private readonly interjectBanner: string;

  private disposed = false;
  private reading = false;       // true while a cooked prompt is active
  private interjecting = false;  // true while opening an interject prompt
  private rawWasEnabled = false;

  private scheduler: ISchedulerLike | undefined;

  private readonly escIController: EscInterjectController;

  constructor(opts: Options & { scheduler?: ISchedulerLike }) {
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    this.promptLabel = opts.prompt;
    this.interjectKey = opts.interjectKey ?? "i";
    this.interjectBanner = opts.interjectBanner ?? opts.prompt;
    this.scheduler = opts.scheduler;

    // Create the ESC/'i' intent controller
    const reviewOpener: ReviewOpener = {
      finalizeAndReview: async () => {
        const res = await this.finalizeAndReviewViaScheduler();
        // Normalize to { patchProduced?: boolean }
        return res ?? { patchProduced: true };
      },
    };
    const interjectionOpener: InterjectionOpener = {
      openInterjectionPrompt: async () => {
        await this.openInterjectPromptOnce();
      },
    };

    this.escIController = new EscInterjectController({
      isInteractive: () => !!(this.stdin as TtyReadStream).isTTY,
      logger: Logger,
      review: reviewOpener,
      interject: interjectionOpener,
      onStatusLine: (msg) => this.statusLine(msg),
    });

    // Raw input setup (single owner)
    if ((this.stdin as TtyReadStream).isTTY) {
      emitKeypressEvents(this.stdin as TtyReadStream);
      (this.stdin as TtyReadStream).setRawMode?.(true);
      this.rawWasEnabled = true;
      (this.stdin as TtyReadStream).on("keypress", this.onKeypress);
    }
  }

  attachScheduler(s: ISchedulerLike): void {
    this.scheduler = s;
  }

  /** External hooks to track model 'chatter' */
  onStreamStart(): void {
    this.escIController.onStreamStart();
  }
  onStreamEnd(): void {
    this.escIController.onStreamEnd();
  }

  /** Public: open one cooked prompt to read a user line (for normal @@user turns) */
  async readUserLine(): Promise<string> {
    return this.withCookedTTY(async () => {
      const rl = createRlInterface({
        input: this.stdin,
        output: this.stdout,
        terminal: true,
      });
      try {
        const answer = await rl.question(this.promptLabel);
        return answer;
      } finally {
        rl.close();
      }
    });
  }

  /** Clean up and restore terminal. Do not call process.exit() here. */
  async unwind(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    try {
      (this.stdin as TtyReadStream).off?.("keypress", this.onKeypress);
    } catch {}
    try {
      if (this.rawWasEnabled) (this.stdin as TtyReadStream).setRawMode?.(false);
    } catch {}
  }

  /* ------------------------------- Internals ------------------------------- */

  private onKeypress = async (_: string, key: Key) => {
    // ESC is always honored (interactive or not)
    if (key.name === "escape" || key.sequence === "\u001b") {
      this.escIController.handleEscKey();
      return;
    }

    // 'i' is only effective in interactive mode, and we allow it in Idle only.
    if (key.name === this.interjectKey) {
      this.escIController.handleInterjectKey();
      return;
    }
  };

  private async openInterjectPromptOnce(): Promise<void> {
    if (this.interjecting) return;
    this.interjecting = true;
    try {
      // Show a single-line cooked prompt
      const line = await this.withCookedTTY(async () => {
        const rl = createRlInterface({
          input: this.stdin,
          output: this.stdout,
          terminal: true,
        });
        try {
          const answer = await rl.question(this.interjectBanner);
          return answer;
        } finally {
          rl.close();
        }
      });
      const text = (line ?? "").trim();
      if (text.length > 0 && hasEnqueueUserText(this.scheduler)) {
        await this.scheduler.enqueueUserText!(text);
      }
    } finally {
      this.interjecting = false;
    }
  }

  private async finalizeAndReviewViaScheduler(): Promise<{ patchProduced: boolean } | void> {
    if (hasFinalizeAndReview(this.scheduler)) {
      const res = await this.scheduler.finalizeAndReview!();
      // If the scheduler doesn't return a shape, assume a patch was produced.
      if (!res) return { patchProduced: true };
      // If it did, try to infer 'patchProduced' boolean.
      if (typeof (res as { patchProduced?: unknown }).patchProduced === "boolean") {
        return { patchProduced: (res as { patchProduced?: boolean }).patchProduced! };
      }
      return { patchProduced: true };
    }

    // Fallback: if no review path known, just exit after unwinding (least-surprising behavior).
    Logger.warn("No finalizeAndReview() available on scheduler; exiting without review.");
    await this.unwind();
    process.exit(0);
  }

  private statusLine(msg: string): void {
    // Minimal: print a single line. If we are in a cooked prompt, readline will redraw;
    // otherwise, emit a plain line.
    this.stdout.write(`${msg}\n`);
  }

  /* --------------------------- Mode helpers (scoped) --------------------------- */

  /** Run fn with terminal in cooked mode, then restore raw. */
  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    if (!(this.stdin as TtyReadStream).isTTY) {
      // Non-interactive: just run
      return await fn();
    }

    // Temporarily disable raw mode and detach keypress listener
    const wasRaw = this.rawWasEnabled;
    const tty = this.stdin as TtyReadStream;
    if (wasRaw) tty.setRawMode?.(false);
    tty.off?.("keypress", this.onKeypress);
    this.reading = true;

    try {
      return await fn();
    } finally {
      // Restore raw mode + listener
      this.reading = false;
      if (wasRaw) tty.setRawMode?.(true);
      tty.on?.("keypress", this.onKeypress);
    }
  }

  /** Raw mode passthrough for symmetry (currently no-op, returns fn()) */
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    return await fn();
  }
}

/* --------------------------- Default singleton & helpers --------------------------- */

// Maintain backward-compat exports that other code may import.
const _default = new TtyController({
  stdin: process.stdin,
  stdout: process.stdout,
  prompt: "user: ",
  interjectKey: "i",
  interjectBanner: "user: ",
});

export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withCookedTTY(fn); }
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withRawTTY(fn); }

// Optional compatibility: allow wiring a scheduler at runtime.
let _scheduler: ISchedulerLike | undefined;
export function setScheduler(s: ISchedulerLike): void {
  _scheduler = s;
  _default.attachScheduler(s);
}
export function getScheduler(): ISchedulerLike | undefined { return _scheduler; }

/* ------------------------------- Type guards -------------------------------- */

function hasEnqueueUserText(x: unknown): x is { enqueueUserText(text: string): Promise<void> | void } {
  return typeof x === "object" && x !== null && "enqueueUserText" in (x as Record<string, unknown>) &&
         typeof (x as Record<string, unknown>)["enqueueUserText"] === "function";
}

function hasFinalizeAndReview(x: unknown): x is { finalizeAndReview(): Promise<void> | Promise<{ patchProduced: boolean }> } {
  return typeof x === "object" && x !== null && "finalizeAndReview" in (x as Record<string, unknown>) &&
         typeof (x as Record<string, unknown>)["finalizeAndReview"] === "function";
}
