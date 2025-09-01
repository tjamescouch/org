// src/input/tty-controller.ts
// Interactive TTY controller with raw-mode key monitoring + external loop option.
// - ESC: graceful finalize + exit (always active in interactive mode)
// - 'i' : interject prompt (only listened for in interactive mode); if pressed
//         during streaming we ACK immediately and defer the prompt until stream end.
// - Public API kept stable for app.ts and the tests.
// - Exposes readUserLine() so a scheduler can drive the user-turn without rendering its own prompt.

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";

/* ----------------------------------------------------------------------------
 * Types & small adapters
 * --------------------------------------------------------------------------*/

export type TtyMode = "raw" | "cooked";

export type TtyIn = Pick<NodeJS.ReadStream, "isTTY"> &
  Partial<Pick<NodeJS.ReadStream, "setRawMode" | "isRaw">> & {
    on(event: "keypress", listener: (str: string, key: Key) => void): this;
    off(event: "keypress", listener: (str: string, key: Key) => void): this;
    on(event: "data", listener: (chunk: Buffer) => void): this;
    off(event: "data", listener: (chunk: Buffer) => void): this;
  };

function hasSetRawMode(s: NodeJS.ReadStream): s is TtyReadStream {
  return typeof (s as { setRawMode?: unknown }).setRawMode === "function";
}
function hasIsRaw(s: NodeJS.ReadStream): s is TtyReadStream & { isRaw: boolean } {
  return typeof (s as { isRaw?: unknown }).isRaw === "boolean";
}

export function toTtyIn(stream: NodeJS.ReadStream): TtyIn {
  const base: TtyIn = stream as any;
  return base;
}

export function stdinTty(): TtyIn { return toTtyIn(process.stdin); }

/* ----------------------------------------------------------------------------
 * Mode manager
 * --------------------------------------------------------------------------*/

class ModeController {
  private current: TtyMode;

  constructor(private readonly tty: TtyIn) {
    if (!tty.isTTY) {
      this.current = "cooked";
    } else if (hasIsRaw(tty)) {
      this.current = tty.isRaw ? "raw" : "cooked";
    } else {
      this.current = "cooked";
    }
  }

  get mode(): TtyMode { return this.current; }

  forceRaw(): void {
    if (this.tty.isTTY && hasSetRawMode(this.tty)) {
      this.tty.setRawMode(true);
      (this.tty as any).isRaw = true;
      this.current = "raw";
    } else {
      this.current = "raw";
    }
  }

  toCooked(): void {
    if (this.tty.isTTY && hasSetRawMode(this.tty)) {
      this.tty.setRawMode(false);
      (this.tty as any).isRaw = false;
      this.current = "cooked";
    } else {
      this.current = "cooked";
    }
  }
}

/* ----------------------------------------------------------------------------
 * Options
 * --------------------------------------------------------------------------*/

export interface TtyControllerOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;

  /** Idle prompt label (e.g., "user: "). A trailing space is enforced. */
  prompt?: string;

  /** Interjection key (default 'i'). */
  interjectKey?: string;

  /** Interjection prompt label (e.g., "user: "). A trailing space is enforced. */
  interjectBanner?: string;

  /** Where acknowledgments and notices go (stderr-like). */
  feedbackStream?: NodeJS.WriteStream;

  /** Optional UX hints (not used for overlays yet). */
  waitOverlayMessage?: string;
  waitSuppressOutput?: boolean;

  /** Called on graceful unwind (signals/exits). */
  finalizer?: () => Promise<void> | void;

  /**
   * Who owns the idle user loop?
   *  - "controller": this class runs the idle loop.
   *  - "external": caller (e.g., the scheduler) drives the loop via readUserLine().
   */
  loopMode?: "controller" | "external";

  /** When true, avoid double-binding in multi-controller scenarios. */
  forceExclusive?: boolean;
}

/* ----------------------------------------------------------------------------
 * Controller
 * --------------------------------------------------------------------------*/

type SchedulerLike = {
  enqueueUserText?: (text: string) => Promise<void> | void;
};

export class TtyController {
  private readonly mode: ModeController;
  private readonly loopMode: "controller" | "external";
  private readonly stdin: TtyIn;
  private readonly stdout: NodeJS.WriteStream;
  private readonly feedback: NodeJS.WriteStream;

  private scheduler: SchedulerLike | undefined;

  private running = false;
  private reading = false;
  private interjecting = false;
  private keyBound = false;

  private streaming = false;
  private escDuringStream = false;
  private interjectDuringStream = false;

  private lastEscAt = 0;
  private lastIAt = 0;

  private onKeypressRef = ("" as any) as ((str: string, key: Key) => void);
  private onDataRef = ("" as any) as ((buf: Buffer) => void);

  private opts: Required<Omit<TtyControllerOptions,
    "finalizer" | "waitOverlayMessage" | "waitSuppressOutput" | "loopMode" | "forceExclusive" | "stdin" | "stdout" | "feedbackStream" |
    "prompt" | "interjectKey" | "interjectBanner">> & {
      finalizer?: () => Promise<void> | void;
      waitOverlayMessage?: string;
      waitSuppressOutput?: boolean;
      loopMode: "controller" | "external";
      forceExclusive: boolean;
      prompt: string;
      interjectKey: string;
      interjectBanner: string;
    };

  constructor(options: TtyControllerOptions = {}) {
    const stdin = toTtyIn((options.stdin ?? process.stdin) as NodeJS.ReadStream);
    const stdout = (options.stdout ?? process.stdout) as NodeJS.WriteStream;
    const feedbackStream = (options.feedbackStream ?? (process.stderr as NodeJS.WriteStream));

    let prompt = options.prompt ?? "user: ";
    if (!prompt.endsWith(" ")) prompt += " ";

    let interjectBanner = options.interjectBanner ?? prompt;
    if (!interjectBanner.endsWith(" ")) interjectBanner += " ";

    const interjectKey = options.interjectKey ?? "i";

    this.opts = {
      prompt,
      interjectKey,
      interjectBanner,
      finalizer: options.finalizer,
      waitOverlayMessage: options.waitOverlayMessage,
      waitSuppressOutput: options.waitSuppressOutput,
      loopMode: options.loopMode ?? "external",
      forceExclusive: options.forceExclusive ?? true,
    };

    this.stdin = stdin;
    this.stdout = stdout;
    this.feedback = feedbackStream;

    this.mode = new ModeController(this.stdin);
    this.loopMode = this.opts.loopMode;
  }

  /* -------------------------------- Public API ------------------------------ */

  setScheduler(s: SchedulerLike): void { this.scheduler = s; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.stdin.isTTY) {
      emitKeypressEvents(this.stdin as any);
      this.mode.forceRaw();

      if (!this.keyBound) {
        this.onKeypressRef = this.onKeypress.bind(this);
        this.onDataRef = this.onData.bind(this);
        (this.stdin as any).on("keypress", this.onKeypressRef);
        (this.stdin as any).on("data", this.onDataRef);
        this.keyBound = true;
      }
    }

    if (this.loopMode === "controller") {
      void this.readLoop();
    }
  }

  async unwind(): Promise<void> {
    this.running = false;
    if (this.keyBound) {
      try { (this.stdin as any).off("keypress", this.onKeypressRef); } catch {}
      try { (this.stdin as any).off("data", this.onDataRef); } catch {}
      this.keyBound = false;
    }
    this.mode.toCooked();
    await Promise.resolve(this.opts.finalizer?.());
  }

  async readUserLine(label?: string): Promise<string> {
    return this.promptOnce(label ?? this.opts.prompt);
  }

  async askUser(_fromAgent: string, content: string): Promise<string | undefined> {
    const ans = await this.promptOnce(this.opts.interjectBanner);
    return ans.trim() === "" ? undefined : ans;
  }

  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.mode.mode;
    this.mode.toCooked();
    try {
      return await Promise.resolve(fn());
    } finally {
      if (prev === "raw") this.mode.forceRaw();
      else this.mode.toCooked();
    }
  }
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.mode.mode;
    this.mode.forceRaw();
    try {
      return await Promise.resolve(fn());
    } finally {
      if (prev === "raw") this.mode.forceRaw();
      else this.mode.toCooked();
    }
  }

  /* -------------------- Streaming coordination hooks ----------------------- */

  onStreamStart(): void {
    this.streaming = true;
  }

  async onStreamEnd(): Promise<void> {
    this.streaming = false;

    if (this.escDuringStream) {
      this.escDuringStream = false;
      await this.finalizeAndReviewAndExit();
      return;
    }

    if (this.interjectDuringStream) {
      this.interjectDuringStream = false;
      const text = await this.promptOnce(this.opts.interjectBanner);
      if (text.trim().length > 0) await Promise.resolve(this.scheduler?.enqueueUserText?.(text));
    }
  }

  /* -------------------------------- Internals ------------------------------- */

  private feedbackWrite(s: string): void {
    try { this.feedback.write(s); } catch { /* ignore */ }
  }

  private onKeypress(_str: string, key: Key): void {
    if (!this.stdin.isTTY) return;

    // Ctrl+C (SIGINT)
    if (key?.name === "c" && (key.ctrl === true || key.sequence === "\u0003")) {
      this.feedbackWrite("SIGINT\n");
      process.exit(130);
      return;
    }

    // Bare ESC
    if (key?.name === "escape" || key?.sequence === "\u001b") {
      this.handleEsc();
      return;
    }

    // 'i'
    if (key?.name === (this.opts.interjectKey || "i")) {
      this.handleI();
      return;
    }
  }

  private onData(buf: Buffer): void {
    if (!this.stdin.isTTY) return;
    if (!buf || buf.length === 0) return;

    const b0 = buf[0];

    // Ctrl+C
    if (b0 === 0x03) {
      this.feedbackWrite("SIGINT\n");
      process.exit(130);
      return;
    }

    // ESC
    if (b0 === 0x1b) {
      this.handleEsc();
      return;
    }

    // 'i'
    if (b0 === "i".charCodeAt(0)) {
      this.handleI();
      return;
    }
  }

  private handleEsc(): void {
    const now = Date.now();
    if (now - this.lastEscAt < 30) return; // debounce
    this.lastEscAt = now;

    if (this.streaming) {
      if (!this.escDuringStream) {
        this.feedbackWrite(`\u23F3 ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)\n`);
      }
      this.escDuringStream = true;
      return;
    }

    // If a prompt is currently open, cancel it and finalize immediately.
    if (this.reading) {
      // promptOnce() listens for ESC and will close itself; if we caught it here,
      // be defensive and let finalize path run.
      void this.finalizeAndReviewAndExit();
      return;
    }

    // Not streaming: finalize immediately
    void this.finalizeAndReviewAndExit();
  }

  private handleI(): void {
    const now = Date.now();
    if (now - this.lastIAt < 30) return; // debounce
    this.lastIAt = now;

    if (!this.stdin.isTTY) return;

    if (this.streaming) {
      if (!this.interjectDuringStream) {
        this.feedbackWrite(`\u23F3 waiting for model to finish…\n`);
      }
      this.interjectDuringStream = true;
      return;
    }

    // Idle interjection: open prompt immediately
    if (!this.reading && !this.interjecting) {
      void (async () => {
        try {
          this.interjecting = true;
          const text = await this.promptOnce(this.opts.interjectBanner);
          if (text.trim().length > 0) {
            await Promise.resolve(this.scheduler?.enqueueUserText?.(text));
          }
        } finally {
          this.interjecting = false;
        }
      })();
    }
  }

  private async promptOnce(label: string): Promise<string> {
    this.reading = true;
    try {
      const prev = this.mode.mode;
      this.mode.toCooked();

      // Build a readline interface and also a temporary ESC watcher.
      const rl = createInterface({ input: this.stdin as any, output: this.stdout as any, terminal: true });

      let escResolve!: (v: string) => void;
      const ESC_SENTINEL = "__ESC__";
      const escPromise = new Promise<string>((resolve) => { escResolve = resolve; });

      // Keypress listener: fires even in cooked mode on many terminals.
      const onKey = (_str: string, key: Key) => {
        if (key?.name === "escape" || key?.sequence === "\u001b") {
          escResolve(ESC_SENTINEL);
        }
      };

      // Fallback cooked 'data' (some shells deliver ESC only with newline; we still catch it).
      const onData = (buf: Buffer) => {
        if (!buf) return;
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] === 0x1b) { escResolve(ESC_SENTINEL); break; }
        }
      };

      // Attach temp listeners
      (this.stdin as any).on("keypress", onKey);
      (this.stdin as any).on("data", onData);

      const questionPromise = rl.question(label);
      let outcome: string;
      try {
        outcome = await Promise.race([questionPromise, escPromise]);
      } finally {
        // Remove the temp listeners and close rl safely if still open
        try { (this.stdin as any).off("keypress", onKey); } catch {}
        try { (this.stdin as any).off("data", onData); } catch {}
        try { rl.close(); } catch {}
      }

      if (outcome === ESC_SENTINEL) {
        // Ensure we render a fresh line (avoid half-typed prompt)
        try { this.stdout.write("\n"); } catch {}
        // Ack + finalize
        this.feedbackWrite(`\u23F3 ESC pressed — opening patch review…\n`);
        await this.finalizeAndReviewAndExit();
        return "";
      }

      return outcome;
    } finally {
      // Restore previous mode and reading flag
      const prev = this.mode.mode;
      if (prev === "raw") this.mode.forceRaw();
      else this.mode.toCooked();
      this.reading = false;
    }
  }

  /** Default idle loop (only when loopMode === "controller"). */
  private async readLoop(): Promise<void> {
    while (this.running) {
      const line = await this.promptOnce(this.opts.prompt);
      const txt = line.trim();
      if (txt.length === 0) continue;
      await Promise.resolve(this.scheduler?.enqueueUserText?.(txt));
    }
  }

  private async finalizeAndReviewAndExit(): Promise<void> {
    try {
      await this.unwind();
      process.exit(0);
    } catch (err) {
      if (err instanceof Error && /^__EXIT__:\d+/.test(err.message)) throw err;
      this.feedbackWrite(`Finalize/review failed: ${String(err)}\n`);
      try { await this.unwind(); } catch { /* ignore */ }
      process.exit(1);
    }
  }
}

/* ----------------------------------------------------------------------------
 * Module-level convenience + compat exports
 * --------------------------------------------------------------------------*/

const _default = new TtyController({
  stdin: process.stdin,
  stdout: process.stdout,
  prompt: "user: ",
  interjectKey: "i",
  interjectBanner: "user: ",
  feedbackStream: process.stderr,
  loopMode: "external",
});

export const defaultTtyController = _default;

export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withCookedTTY(fn); }
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withRawTTY(fn); }

let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }

export default _default;
