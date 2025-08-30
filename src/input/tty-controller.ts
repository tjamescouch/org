// src/input/tty-controller.ts
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";

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

class ModeController {
  constructor(private readonly tty: TtyIn, private current: TtyMode = (!tty.isTTY ? "cooked" : tty.isRaw ? "raw" : "cooked")) {}
  get mode(): TtyMode { return this.current; }
  forceRaw(): void { if (this.tty.isTTY && this.tty.setRawMode) { this.tty.setRawMode(true); this.current = "raw"; } }
  toCooked(): void { if (this.tty.isTTY && this.tty.setRawMode) { this.tty.setRawMode(false); this.current = "cooked"; } }
}

export interface TtyControllerOptions {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  prompt: string;              // e.g., "user: "
  interjectKey: string;        // default "i"
  interjectBanner: string;     // e.g., "user: "
  waitOverlayMessage?: string;
  waitSuppressOutput?: boolean;
  finalizer?: () => Promise<void> | void;
  /** Who owns the idle input loop? default "controller". */
  loopMode?: "controller" | "external";
}

export class TtyController {
  private readonly mode: ModeController;
  private scheduler: IScheduler | undefined;
  private running = false;
  private reading = false;
  private interjecting = false;
  private keyBound = false;
  private readonly loopMode: "controller" | "external";

  constructor(private readonly opts: TtyControllerOptions) {
    if (!this.opts.prompt.endsWith(" ")) this.opts.prompt += " ";
    if (!this.opts.interjectBanner.endsWith(" ")) this.opts.interjectBanner += " ";
    this.mode = new ModeController(toTtyIn(opts.stdin));
    this.loopMode = opts.loopMode ?? "controller";
  }

  setScheduler(s: IScheduler): void { this.scheduler = s; }

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

  async unwind(): Promise<void> {
    this.running = false;
    if (this.keyBound) { this.opts.stdin.off("keypress", this.onKeypress); this.keyBound = false; }
    this.mode.toCooked();
    await Promise.resolve(this.opts.finalizer?.());
  }

  /** Public: let external owners (e.g., scheduler) read one line using our cooked prompt. */
  async readUserLine(label?: string): Promise<string> {
    return this.promptOnce(label ?? this.opts.prompt);
  }

  /** Agent asks the user a question. */
  async askUser(_fromAgent: string, content: string): Promise<string | undefined> {
    await this.writeLine(content.trim());
    const ans = await this.promptOnce(this.opts.interjectBanner);
    return ans.trim() === "" ? undefined : ans;
  }

  withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return Promise.resolve(fn()); }
  withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return Promise.resolve(fn()); }

  // ---- internals ----
  private onKeypress = async (_: string, key: import("node:readline").Key) => {
    if (key.name === "escape" || key.sequence === "\u001b") { await this.unwind(); process.exit(0); }
    if (!this.reading && !this.interjecting && key.name === (this.opts.interjectKey || "i")) {
      try {
        this.interjecting = true;
        const text = await this.promptOnce(this.opts.interjectBanner);
        if (text.trim().length > 0) await this.scheduler?.enqueueUserText(text);
      } finally { this.interjecting = false; }
    }
  };

  private async writeLine(s: string): Promise<void> {
    if (s.length === 0) return;
    await Promise.resolve(this.opts.stdout.write(s + "\n"));
  }

  private async promptOnce(label: string): Promise<string> {
    this.reading = true;
    try {
      const rl = createInterface({ input: this.opts.stdin, output: this.opts.stdout, terminal: true });
      try { return await rl.question(label); } finally { rl.close(); }
    } finally { this.reading = false; }
  }

  private async readLoop(): Promise<void> {
    while (this.running) {
      const line = await this.promptOnce(this.opts.prompt);
      const txt = line.trim();
      if (txt.length === 0) continue;
      await this.scheduler?.enqueueUserText(txt);
    }
  }
}

// module-level helpers (unchanged)
const _default = new TtyController({ stdin: process.stdin, stdout: process.stdout, prompt: "user: ", interjectKey: "i", interjectBanner: "user: " });
export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withCookedTTY(fn); }
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withRawTTY(fn); }
let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }
