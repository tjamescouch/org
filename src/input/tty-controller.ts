// src/input/tty-controller.ts
// Interactive TTY controller with raw-mode key monitoring and an external loop option.
// - Fixes duplicate echo by keeping stdin in raw mode while running
// - Esc: graceful finalize + exit
// - 'i': interject prompt while idle
// - Public API kept stable for app.ts and callers
// - Exposes readUserLine() so a scheduler can drive the user-turn without rendering its own prompt

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";
import { C, Logger } from "../logger";

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
  if (hasSetRawMode(stream)) base.setRawMode = (m: boolean) => (stream as TtyReadStream).setRawMode(m);
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

  /** Optional UX hints; not yet used for rendering overlays. */
  waitOverlayMessage?: string;
  waitSuppressOutput?: boolean;

  /** Called on graceful unwind (signals/exits). */
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
  private scheduler: IScheduler | undefined;
  private running = false;
  private reading = false;
  private interjecting = false;
  private keyBound = false;

  constructor(private readonly opts: TtyControllerOptions) {
    if (!this.opts.prompt.endsWith(" ")) this.opts.prompt += " ";
    if (!this.opts.interjectBanner.endsWith(" ")) this.opts.interjectBanner += " ";
    this.mode = new ModeController(toTtyIn(opts.stdin));
    this.loopMode = opts.loopMode ?? "controller";
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
  async askUser(_fromAgent: string, content: string): Promise<string | undefined> {
    //Logger.info(C.green(content.trim()));
    const ans = await this.promptOnce(this.opts.interjectBanner);
    return ans.trim() === "" ? undefined : ans;
  }

  /** Scoped helpers left as pass-through; readline already handles cooked behavior under raw. */
  withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return Promise.resolve(fn()); }
  withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return Promise.resolve(fn()); }

  /* ------------------------------- Internals ------------------------------- */

  private onKeypress = async (_: string, key: Key) => {
    // Esc → graceful exit path
    if (key.name === "escape" || key.sequence === "\u001b") {
      await this.unwind();
      process.exit(0);
    }
    // Interject only when idle (not currently prompting)
    if (!this.reading && !this.interjecting && key.name === (this.opts.interjectKey || "i")) {
      try {
        this.interjecting = true;
        const text = await this.promptOnce(this.opts.interjectBanner);
        if (text.trim().length > 0) {
          await this.scheduler?.enqueueUserText(text);
        }
      } finally {
        this.interjecting = false;
      }
    }
  };

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
});

export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withCookedTTY(fn); }
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withRawTTY(fn); }

// Optional compatibility: some older code stores a scheduler here.
let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }
