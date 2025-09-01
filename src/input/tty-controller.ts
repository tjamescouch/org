// src/input/tty-controller.ts
// Hotkeys + robust RAW/COOKED handling with explicit flow restoration.
// - ESC: graceful (defer until stream end, then finalize+review)
// - 'i': interject (interactive mode only; deferred while streaming)
// - Keep stdin in RAW for the session; switch to COOKED only for a prompt,
//   then restore RAW **and resume()** so key bytes flow again.
// - Immediate feedback to stderr (never competes with model tokens).
// - Non‑interactive (no TTY): hotkeys disabled automatically.

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";
import { Logger } from "../logger";
import { R } from "../runtime/runtime";

/* ------------------------------ small debug helper ------------------------------ */
const DBG =
  (process.env.ORG_TTY_DEBUG === "1" ||
   process.env.DEBUG_TTY === "1" ||
   process.env.DEBUG === "tty");

function dlog(...args: any[]) {
  if (!DBG) return;
  try { (process.stderr || console).write(`[tty] ${args.join(" ")}\n`); } catch {}
}

/* --------------------------------- helpers ---------------------------------- */
function hasSetRawMode(s: NodeJS.ReadStream): s is TtyReadStream {
  return typeof (s as { setRawMode?: unknown }).setRawMode === "function";
}
function hasIsRaw(s: NodeJS.ReadStream): s is TtyReadStream & { isRaw: boolean } {
  return typeof (s as { isRaw?: unknown }).isRaw === "boolean";
}

/* ------------------------------ Controller API ------------------------------ */

export interface TtyControllerOptions {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  prompt: string;
  interjectKey: string;
  interjectBanner: string;
  waitOverlayMessage?: string;
  finalizer?: () => Promise<void> | void;
  loopMode?: "controller" | "external";
  feedbackStream?: NodeJS.WriteStream;
  forceExclusive?: boolean;
}

export class TtyController {
  private readonly loopMode: "controller" | "external";
  private scheduler: IScheduler | undefined;

  private running = false;
  private reading = false;
  private interjecting = false;

  private streaming = false;
  private shutdownRequested = false;
  private interjectPending = false;
  private reviewInFlight = false;

  private keypressBound = false;
  private dataBound = false;

  private readonly feedback: NodeJS.WriteStream;
  private readonly interjectKeyName: string;

  private lastEscAt = 0;
  private lastIAt = 0;

  constructor(private readonly opts: TtyControllerOptions) {
    if (!this.opts.prompt.endsWith(" ")) this.opts.prompt += " ";
    if (!this.opts.interjectBanner.endsWith(" ")) this.opts.interjectBanner += " ";
    this.loopMode = opts.loopMode ?? "controller";
    this.feedback = opts.feedbackStream ?? process.stderr;
    this.interjectKeyName = (opts.interjectKey || "i").toLowerCase();
  }

  setScheduler(s: IScheduler): void { this.scheduler = s; }

  /* --------------------------------- lifecycle -------------------------------- */

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const { stdin } = this.opts;
    if (!stdin.isTTY) {
      dlog("start: stdin not a TTY → hotkeys disabled");
      return;
    }

    try { emitKeypressEvents(stdin as any); dlog("emitKeypressEvents: ok"); } catch { dlog("emitKeypressEvents: failed"); }
    this.toRaw("start");
    this.ensureFlow("start");

    if (this.opts.forceExclusive) {
      try {
        const prev = (stdin as any).rawListeners?.("keypress") ?? (stdin as any).listeners?.("keypress") ?? [];
        for (const fn of prev) { try { (stdin as any).off?.("keypress", fn); } catch {} }
      } catch {}
    }

    if (!this.keypressBound) { (stdin as any).on("keypress", this.onKeypress); this.keypressBound = true; }
    if (!this.dataBound)     { (stdin as any).on("data",     this.onData);     this.dataBound     = true; }
  }

  async unwind(): Promise<void> {
    const { stdin } = this.opts;
    this.running = false;

    if (stdin.isTTY) {
      try { (stdin as any).off?.("keypress", this.onKeypress); this.keypressBound = false; } catch {}
      try { (stdin as any).off?.("data",     this.onData);     this.dataBound     = false; } catch {}
      this.toCooked("unwind");
    }

    await Promise.resolve(this.opts.finalizer?.());
  }

  /* ------------------------------- scheduler hooks --------------------------- */

  onStreamStart(): void {
    this.streaming = true;
    // Defensive: after any model starts streaming, make sure stdin still flows.
    this.toRaw("onStreamStart");
    this.ensureFlow("onStreamStart");
  }

  async onStreamEnd(): Promise<void> {
    this.streaming = false;
    if (this.shutdownRequested) { this.shutdownRequested = false; await this.finalizeAndReviewAndExit(); return; }
    if (this.interjectPending)  { this.interjectPending  = false; await this.openInterjectionPromptOnce(); }
  }

  /* ------------------------------ public prompting --------------------------- */

  async readUserLine(label?: string): Promise<string> {
    return this.promptOnce(label ?? this.opts.prompt);
  }

  async askUser(_fromAgent: string, _content: string): Promise<string | undefined> {
    const ans = await this.promptOnce(this.opts.interjectBanner);
    return ans.trim() === "" ? undefined : ans;
  }

  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return await Promise.resolve(fn()); }
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return await Promise.resolve(fn()); }

  /* --------------------------------- key handlers ---------------------------- */

  private onKeypress = async (_: string, key: Key) => {
    const now = Date.now();
    if ((key.ctrl && key.name === "c") || key.sequence === "\x03") {
      try { this.status(`SIGINT`); } finally { process.exit(130); }
      return;
    }
    if (key.name === "escape" || key.sequence === "\u001b") {
      if (now - this.lastEscAt < 50) return; this.lastEscAt = now;
      await this.handleEsc();
      return;
    }
    if ((key.name || "").toLowerCase() === this.interjectKeyName) {
      if (now - this.lastIAt < 50) return; this.lastIAt = now;
      await this.handleInterjectHit();
      return;
    }
  };

  private onData = async (chunk: Buffer | string) => {
    // Raw-byte fallback for ESC/Ctrl+C/'i'
    try {
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (buf.length === 0) return;

      const now = Date.now();

      if (buf[0] === 0x03) { // Ctrl+C
        try { this.status(`SIGINT`); } finally { process.exit(130); }
        return;
      }
      if (buf.length === 1 && buf[0] === 0x1b) {
        if (now - this.lastEscAt < 50) return; this.lastEscAt = now;
        await this.handleEsc(); return;
      }
      if (buf.length === 1 && (buf[0] === 0x69 || buf[0] === 0x49)) {
        if (now - this.lastIAt < 50) return; this.lastIAt = now;
        await this.handleInterjectHit(); return;
      }
    } catch { /* ignore */ }
  };

  /* --------------------------------- actions -------------------------------- */

  private async handleEsc(): Promise<void> {
    if (!this.opts.stdin.isTTY) return; // non-interactive
    if (this.streaming) {
      this.shutdownRequested = true;
      this.status(this.opts.waitOverlayMessage ??
        "⏳ ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)");
      return;
    }
    await this.finalizeAndReviewAndExit();
  }

  private async handleInterjectHit(): Promise<void> {
    if (!this.opts.stdin.isTTY) return; // interactive only
    if (this.reading || this.interjecting) return;
    if (this.streaming) {
      this.interjectPending = true;
      this.status("…waiting for model to finish before interjection");
      return;
    }
    await this.openInterjectionPromptOnce();
  }

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
      await this.unwind();   // runs finalizer (stop→drain→review)
      process.exit(0);
    } catch (err) {
      Logger.warn(`Finalize/review failed: ${String(err)}`);
      try { await this.unwind(); } catch {}
      process.exit(1);
    } finally {
      this.reviewInFlight = false;
    }
  }

  /* -------------------- RAW / COOKED + **flow** transitions ------------------- */

  private toRaw(tag: string): void {
    const { stdin } = this.opts;
    if (!stdin.isTTY || !hasSetRawMode(stdin)) return;
    try {
      if (!hasIsRaw(stdin) || !(stdin as any).isRaw) {
        stdin.setRawMode!(true);
        dlog(`${tag}: RAW`);
      }
    } catch {}
  }

  private toCooked(tag: string): void {
    const { stdin } = this.opts;
    if (!stdin.isTTY || !hasSetRawMode(stdin)) return;
    try {
      if (!hasIsRaw(stdin) || (stdin as any).isRaw) {
        stdin.setRawMode!(false);
        dlog(`${tag}: COOKED`);
      }
    } catch {}
  }

  /** Ensure the stdin stream is flowing. Readline sometimes pauses it on close(). */
  private ensureFlow(tag: string): void {
    try {
      (this.opts.stdin as any).resume?.();
      // schedule a second resume on the next tick in case readline pauses after our callback
      setImmediate(() => { try { (this.opts.stdin as any).resume?.(); } catch {} });
      dlog(`${tag}: resume()`);
    } catch {}
  }

  /** Execute one readline prompt in COOKED; then return to RAW **and resume()**. */
  private async promptOnce(label: string): Promise<string> {
    this.reading = true;
    this.toCooked("prompt");
    try {
      const rl = createInterface({ input: this.opts.stdin, output: this.opts.stdout, terminal: true });
      try { return await rl.question(label); }
      finally { rl.close(); }
    } finally {
      this.reading = false;
      this.toRaw("prompt→return");
      this.ensureFlow("prompt→return");
    }
  }

  /* --------------------------------- misc --------------------------------- */

  private status(msg: string): void {
    try { this.feedback.write(`\n${msg}\n`); } catch {}
  }

  /* ---------------------------- controller-owned loop --------------------------- */

  private async readLoop(): Promise<void> {
    while (this.running) {
      const line = await this.promptOnce(this.opts.prompt);
      const txt = line.trim();
      if (txt.length === 0) continue;
      await this.scheduler?.enqueueUserText(txt);
    }
  }
}

/* -------------------------- legacy module-level facade ------------------------- */

const _default = new TtyController({
  stdin: process.stdin,
  stdout: process.stdout,
  prompt: "user: ",
  interjectKey: "i",
  interjectBanner: "user: ",
  feedbackStream: process.stderr,
  forceExclusive: true,
});

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

// Optional compatibility storage
let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }
