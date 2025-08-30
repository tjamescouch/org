// src/input/tty-controller.ts
// Interactive TTY controller + scoped mode helpers.
// - Provides start(), askUser(), setScheduler(), unwind(), withCookedTTY/withRawTTY()
// - Uses readline/promises for line input (always under cooked TTY)
// - Type-safe (no `as any`), exception-safe, re-entrant.

// Node / types
import { createInterface } from "node:readline/promises";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";

// ------------------------------ Minimal TTY types ------------------------------

export type TtyMode = "raw" | "cooked";

/** Minimal surface we require from a TTY-like input stream. */
export type TtyIn = Pick<NodeJS.ReadStream, "isTTY"> &
  Partial<Pick<NodeJS.ReadStream, "setRawMode" | "isRaw">>;

// ------------------------------ Adapters --------------------------------------

function hasSetRawMode(s: NodeJS.ReadStream): s is TtyReadStream {
  return typeof (s as { setRawMode?: unknown }).setRawMode === "function";
}
function hasIsRaw(s: NodeJS.ReadStream): s is TtyReadStream & { isRaw: boolean } {
  return typeof (s as { isRaw?: unknown }).isRaw === "boolean";
}

/** Convert any NodeJS.ReadStream into a minimal TtyIn. */
export function toTtyIn(stream: NodeJS.ReadStream): TtyIn {
  const base: TtyIn = { isTTY: stream.isTTY === true };
  if (hasIsRaw(stream)) base.isRaw = stream.isRaw;
  if (hasSetRawMode(stream)) {
    base.setRawMode = (mode: boolean) => (stream as TtyReadStream).setRawMode(mode);
  }
  return base;
}

/** Convenience: adapt process.stdin to TtyIn. */
export function stdinTty(): TtyIn {
  return toTtyIn(process.stdin);
}

// ------------------------------ Mode controller --------------------------------

class ModeController {
  private readonly tty: TtyIn;
  private readonly stack: TtyMode[] = [];
  private current: TtyMode;

  constructor(tty: TtyIn) {
    this.tty = tty;
    this.current = !tty.isTTY ? "cooked" : tty.isRaw ? "raw" : "cooked";
  }

  get mode(): TtyMode { return this.current; }

  setMode(next: TtyMode): void {
    if (!this.tty.isTTY || typeof this.tty.setRawMode !== "function") {
      this.current = next;
      return;
    }
    const wantRaw = next === "raw";
    const isRaw = this.tty.isRaw === true;
    if (wantRaw && !isRaw) this.tty.setRawMode(true);
    if (!wantRaw && isRaw) this.tty.setRawMode(false);
    this.current = next;
  }

  async withCooked<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withScoped("cooked", fn);
  }
  async withRaw<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withScoped("raw", fn);
  }

  private async withScoped<T>(next: TtyMode, fn: () => Promise<T> | T): Promise<T> {
    this.stack.push(this.current);
    try {
      this.setMode(next);
      return await fn();
    } finally {
      const prev = this.stack.pop() ?? "cooked";
      this.setMode(prev);
    }
  }
}

// ------------------------------ Interactive controller -------------------------

export interface TtyControllerOptions {
  /** Label shown when prompting for a normal line (e.g., "user: "). */
  prompt: string;
  /** Key used for interjection (reserved for later; not yet wired). */
  interjectKey: string;
  /** Label shown when interjecting. */
  interjectBanner: string;

  /** Optional waiting overlay copy & behavior (reserved for later). */
  waitOverlayMessage?: string;
  waitSuppressOutput?: boolean;

  /** Raw streams (no global process coupling). */
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;

  /** Called on graceful unwind (signals/exits). */
  finalizer?: () => Promise<void> | void;
}

export class TtyController {
  private readonly opts: TtyControllerOptions;
  private readonly mode: ModeController;
  private scheduler: IScheduler | undefined;
  private running = false;
  private loop?: Promise<void>;

  constructor(opts: TtyControllerOptions) {
    this.opts = opts;
    this.mode = new ModeController(toTtyIn(opts.stdin));
    // Ensure prompts always have a trailing space
    if (!this.opts.prompt.endsWith(" ")) this.opts.prompt = `${this.opts.prompt} `;
    if (!this.opts.interjectBanner.endsWith(" ")) {
      this.opts.interjectBanner = `${this.opts.interjectBanner} `;
    }
  }

  // --------- Public API expected by app.ts ---------

  setScheduler(s: IScheduler): void {
    this.scheduler = s;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loop = this.readLoop(); // do not await here
  }

  /** Clean up + call finalizer if provided. */
  async unwind(): Promise<void> {
    this.running = false;
    try { await this.loop; } catch { /* ignore */ }
    await Promise.resolve(this.opts.finalizer?.());
  }

  /** Ask the user a one-off question prompted by an agent. */
  async askUser(_fromAgent: string, content: string): Promise<string | undefined> {
    // Prepend the agent's content, then prompt for a reply.
    await this.mode.withCooked(async () => {
      if (content.trim().length > 0) {
        this.opts.stdout.write(`${content.trim()}\n`);
      }
    });
    const ans = await this.promptOnce(this.opts.interjectBanner);
    return ans.trim() === "" ? undefined : ans;
  }

  /** Scoped helpers exposed so other modules can reuse them through the controller. */
  withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return this.mode.withCooked(fn); }
  withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return this.mode.withRaw(fn); }

  // --------- Internals ---------

  private async promptOnce(label: string): Promise<string> {
    return this.mode.withCooked(async () => {
      const rl = createInterface({ input: this.opts.stdin, output: this.opts.stdout, terminal: true });
      try {
        return await rl.question(label);
      } finally {
        rl.close();
      }
    });
  }

  /** Main interactive loop: prompt → enqueue to scheduler. */
  private async readLoop(): Promise<void> {
    while (this.running) {
      const line = await this.promptOnce(this.opts.prompt);
      const txt = line.trim();
      if (txt.length === 0) continue;
      await this.scheduler?.enqueueUserText(txt);
    }
  }
}

// ------------------------------ Module-level helpers --------------------------

/** Convenience singleton bound to process.stdin/out for ad-hoc callers. */
const defaultController = new TtyController({
  stdin: process.stdin,
  stdout: process.stdout,
  prompt: "user: ",
  interjectKey: "i",
  interjectBanner: "user: ",
});

/** Named helpers used by other modules. */
export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
  return defaultController.withCookedTTY(fn);
}
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> {
  return defaultController.withRawTTY(fn);
}

// Optional compatibility: some older code stores a scheduler globally.
let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }
