// src/input/tty-controller.ts
// Interactive TTY controller with raw-mode key monitoring and an external loop option.
// - Keeps stdin in raw mode during idle/streaming to avoid duplicate echo
// - Switches to cooked mode ONLY while prompting (readline), then restores raw
// - Esc: graceful finalize + exit (waits for streaming to finish, then patch review)
// - 'i': interject prompt while idle; if streaming, queue and open after stream ends
// - Public API kept stable for app.ts and callers

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";
import { Logger } from "../logger";

/* ----------------------------- Types & adapters ----------------------------- */

export type TtyMode = "raw" | "cooked";

export type TtyIn = Pick<NodeJS.ReadStream, "isTTY"> &
  Partial<Pick<NodeJS.ReadStream, "setRawMode" | "isRaw" | "off" | "on">>;

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
  (base as NodeJS.ReadStream).on = (stream as NodeJS.ReadStream).on?.bind(stream as NodeJS.ReadStream);
  (base as NodeJS.ReadStream).off = (stream as NodeJS.ReadStream).off?.bind(stream as NodeJS.ReadStream);
  return base;
}

export function stdinTty(): TtyIn { return toTtyIn(process.stdin); }

/* ------------------------------- Mode manager ------------------------------- */

class ModeController {
  private current: TtyMode;

  constructor(private readonly tty: TtyIn) {
    this.current = !tty.isTTY ? "cooked" : tty.isRaw ? "raw" : "cooked";
  }

  get mode(): TtyMode { return this.current; }
  isInteractive(): boolean { return this.tty.isTTY === true; }

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

  /** Temporarily switch to cooked; return a disposer that restores raw. */
  toCookedScoped(detach?: () => void, reattach?: () => void): () => void {
    const wasRaw = this.current === "raw";
    if (wasRaw) this.toCooked();
    detach?.();
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      reattach?.();
      if (wasRaw) this.forceRaw();
    };
  }
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

  /** Optional UX hints (printed once on ESC while streaming). */
  waitOverlayMessage?: string;
  waitSuppressOutput?: boolean;

  /** Called on graceful unwind (signals/ESC). Must perform: stop → drain → review/pager. */
  finalizer?: () => Promise<void> | void;

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
  private schedulerNominal: IScheduler | undefined; // enqueueUserText (typed)
  private schedulerAny: unknown | undefined;        // finalizeAndReview (optional at runtime)
  private running = false;
  private reading = false;
  private interjecting = false;
  private keyBound = false;

  // Streaming/intent state
  private streaming = false;            // true while model is "chattering"
  private shutdownRequested = false;    // ESC pressed while streaming -> defer finalize
  private interjectPending = false;     // 'i' pressed while streaming -> open after stream
  private reviewInFlight = false;       // idempotency: avoid opening review twice
  private statusShown = { esc: false, i: false };

  constructor(private readonly opts: TtyControllerOptions) {
    if (!this.opts.prompt.endsWith(" ")) this.opts.prompt += " ";
    if (!this.opts.interjectBanner.endsWith(" ")) this.opts.interjectBanner += " ";
    this.mode = new ModeController(toTtyIn(opts.stdin));
    this.loopMode = opts.loopMode ?? "controller";
  }

  /* ------------------------------ Public API ------------------------------ */

  setScheduler(s: IScheduler): void {
    this.schedulerNominal = s;
    this.schedulerAny = s;
  }

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
    // ALWAYS switch to cooked for readline prompts to avoid hangs.
    return this.withCookedTTY(() => this.promptOnce(label ?? this.opts.prompt));
  }

  /** Agent asks the user for input; we print the content then prompt once. */
  async askUser(_fromAgent: string, content: string): Promise<string | undefined> {
    // In cooked mode, readline will render correctly.
    const ans = await this.withCookedTTY(() => this.promptOnce(this.opts.interjectBanner));
    return ans.trim() === "" ? undefined : ans;
  }

  /** Switch to cooked mode for the duration of `fn`, then restore raw + keypress. */
  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    if (!this.mode.isInteractive()) {
      return await Promise.resolve(fn());
    }
    const detach = () => { if (this.keyBound) this.opts.stdin.off?.("keypress", this.onKeypress); };
    const reattach = () => { if (this.keyBound) this.opts.stdin.on?.("keypress", this.onKeypress); };
    const restore = this.mode.toCookedScoped(detach, reattach);
    try {
      return await Promise.resolve(fn());
    } finally {
      restore();
    }
  }

  /** Raw passthrough (kept for API parity). */
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return await Promise.resolve(fn()); }

  /** Called by the scheduler when the model starts emitting tokens. */
  onStreamStart(): void {
    this.streaming = true;
    this.statusShown.esc = false;
    this.statusShown.i = false;
  }

  /** Called by the scheduler when the model finishes emitting tokens. */
  async onStreamEnd(): Promise<void> {
    this.streaming = false;

    // Highest priority: finalize if ESC was pressed during streaming
    if (this.shutdownRequested) {
      this.shutdownRequested = false; // consume
      await this.finalizeAndReviewAndExit();
      return;
    }

    // Next: open a queued interjection
    if (this.interjectPending) {
      this.interjectPending = false;
      await this.openInterjectionPromptOnce();
    }
  }

  /* ------------------------------- Internals ------------------------------- */

  private onKeypress = async (_: string, key: Key) => {
    // Esc → graceful exit path (always active, interactive or not)
    if (key.name === "escape" || key.sequence === "\u001b") {
      if (this.streaming) {
        // Defer finalize until stream end; give immediate feedback once.
        this.shutdownRequested = true;
        if (!this.statusShown.esc) {
          this.statusShown.esc = true;
          this.statusLine(
            this.opts.waitOverlayMessage ??
              "⏳ ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)"
          );
        }
        return;
      }
      await this.finalizeAndReviewAndExit();
      return;
    }

    // Interject only when interactive
    if (key.name === (this.opts.interjectKey || "i")) {
      if (!this.mode.isInteractive()) return;

      // If currently prompting/opening an interjection, ignore repeat presses
      if (this.reading || this.interjecting) return;

      if (this.streaming) {
        // Queue interjection until the stream completes; give feedback once.
        this.interjectPending = true;
        if (!this.statusShown.i) {
          this.statusShown.i = true;
          this.statusLine("…waiting for model to finish before interjection");
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
      const text = await this.withCookedTTY(() => this.promptOnce(this.opts.interjectBanner));
      if (text.trim().length > 0 && hasEnqueueUserText(this.schedulerNominal)) {
        await this.schedulerNominal.enqueueUserText(text);
      }
    } finally {
      this.interjecting = false;
    }
  }

  private async finalizeAndReviewAndExit(): Promise<void> {
    if (this.reviewInFlight) return;
    this.reviewInFlight = true;
    try {
      // Unwind switches to cooked and invokes the provided finalizer (stop → drain → review/apply).
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
    try {
      // Ensure it lands on a fresh line and is visible even during streaming.
      this.opts.stdout.write(`\n${msg}\n`);
    } catch {
      // ignore write errors on teardown
    }
  }

  /** Default idle loop (only when loopMode === "controller"). */
  private async readLoop(): Promise<void> {
    while (this.running) {
      const line = await this.withCookedTTY(() => this.promptOnce(this.opts.prompt));
      const txt = line.trim();
      if (txt.length === 0) continue;
      if (hasEnqueueUserText(this.schedulerNominal)) {
        await this.schedulerNominal.enqueueUserText(txt);
      }
    }
  }
}

/* ------------------------- Module-level convenience ------------------------- */
// (Kept for API parity; the runtime uses its own instance.)

const _default = new TtyController({
  stdin: process.stdin,
  stdout: process.stdout,
  prompt: "user: ",
  interjectKey: "i",
  interjectBanner: "user: ",
});

export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withCookedTTY(fn); }
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withRawTTY(fn); }

// Optional compatibility: some older code stores a scheduler here.
let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }

/* ------------------------------- Type guards ------------------------------- */

function hasEnqueueUserText(x: unknown): x is { enqueueUserText(text: string): Promise<void> | void } {
  return typeof x === "object" && x !== null &&
         "enqueueUserText" in (x as Record<string, unknown>) &&
         typeof (x as Record<string, unknown>)["enqueueUserText"] === "function";
}
