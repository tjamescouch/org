// src/input/tty-controller.ts
// Runtime-owned TTY controller with portable hotkeys and rich debug logging.
// - Primary: 'keypress' path (readline-based), portable in Bun/Node
// - Fallback: raw 'data' byte parser (ESC/Ctrl+C/'i'), so hotkeys still work
// - Immediate feedback goes to stderr (feedbackStream) to avoid contention
// - Non-interactive (no TTY): hotkeys disabled automatically
// - Exposes start()/unwind() and proxies start() when called via legacy ttyStart()

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";
import { Logger } from "../logger";
import { R } from "../runtime/runtime";

/* ------------------------------- Debug flag -------------------------------- */

const TTY_DEBUG =
  (typeof process !== "undefined" &&
    (process.env.ORG_TTY_DEBUG === "1" ||
     process.env.DEBUG_TTY === "1" ||
     process.env.DEBUG === "tty")) || false;

function dlog(...args: any[]) {
  if (!TTY_DEBUG) return;
  try { (process.stderr || console).write(`[tty] ${args.join(" ")}\n`); } catch { /* ignore */ }
}

/* ----------------------------- Types & helpers ----------------------------- */

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

  /** Called on graceful unwind (signals/ESC): should perform stop→drain→review. */
  finalizer?: () => Promise<void> | void;

  /** Who owns the idle user loop? We keep for API parity; you use "external". */
  loopMode?: "controller" | "external";

  /** Where to print hotkey feedback; defaults to stderr. */
  feedbackStream?: NodeJS.WriteStream;

  /** If true, we force exclusive ownership: remove other 'keypress' listeners. */
  forceExclusive?: boolean;
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

  private streaming = false;
  private shutdownRequested = false;
  private interjectPending = false;
  private reviewInFlight = false;

  private keypressBound = false;
  private dataBound = false;

  private readonly feedback: NodeJS.WriteStream;
  private readonly interjectKeyName: string;

  // used to suppress duplicate handling if both handlers fire
  private lastEscAt = 0;
  private lastIAt = 0;

  constructor(private readonly opts: TtyControllerOptions) {
    if (!this.opts.prompt.endsWith(" ")) this.opts.prompt += " ";
    if (!this.opts.interjectBanner.endsWith(" ")) this.opts.interjectBanner += " ";
    this.loopMode = opts.loopMode ?? "controller";
    this.feedback = opts.feedbackStream ?? process.stderr;
    this.interjectKeyName = (opts.interjectKey || "i").toLowerCase();
  }

  /* ------------------------------ Public API ------------------------------ */

  setScheduler(s: IScheduler): void { this.scheduler = s; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const { stdin } = this.opts;
    if (!stdin.isTTY) {
      dlog("start: no TTY → hotkeys disabled");
      return;
    }

    // Own the TTY
    try { emitKeypressEvents(stdin as any); dlog("emitKeypressEvents OK"); } catch { dlog("emitKeypressEvents failed"); }
    try { hasSetRawMode(stdin) && stdin.setRawMode!(true); dlog("setRawMode(true)"); } catch { dlog("setRawMode failed"); }
    try { (stdin as any).resume?.(); dlog("stdin.resume()"); } catch { /* ignore */ }

    // (Optional) ensure exclusive ownership of 'keypress' to avoid duplicates
    if (this.opts.forceExclusive) {
      try {
        const existing = (stdin as any).rawListeners?.("keypress") ?? (stdin as any).listeners?.("keypress") ?? [];
        if (existing.length > 0) dlog(`forceExclusive: removing ${existing.length} prior keypress listeners`);
        existing.forEach((fn: any) => { try { (stdin as any).off?.("keypress", fn); } catch { /* ignore */ } });
      } catch { /* ignore */ }
    }

    // Primary path: keypress
    if (!this.keypressBound) {
      (stdin as any).on("keypress", this.onKeypress);
      this.keypressBound = true;
      dlog("keypress handler bound");
    }

    // Fallback: raw byte path (data) — attach too, but dedupe in handler
    if (!this.dataBound) {
      (stdin as any).on("data", this.onData);
      this.dataBound = true;
      dlog("data handler bound (fallback)");
    }

    if (this.loopMode === "controller") {
      void this.readLoop();
    }
  }

  async unwind(): Promise<void> {
    const { stdin } = this.opts;
    this.running = false;

    if (stdin.isTTY) {
      try { (stdin as any).off?.("keypress", this.onKeypress); this.keypressBound = false; } catch { /* ignore */ }
      try { (stdin as any).off?.("data", this.onData); this.dataBound = false; } catch { /* ignore */ }
      try { hasSetRawMode(stdin) && stdin.setRawMode!(false); dlog("setRawMode(false)"); } catch { /* ignore */ }
    }

    await Promise.resolve(this.opts.finalizer?.());
  }

  async readUserLine(label?: string): Promise<string> {
    return this.promptOnce(label ?? this.opts.prompt);
  }

  async askUser(_fromAgent: string, _content: string): Promise<string | undefined> {
    const ans = await this.promptOnce(this.opts.interjectBanner);
    return ans.trim() === "" ? undefined : ans;
  }

  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return await Promise.resolve(fn()); }
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return await Promise.resolve(fn()); }

  onStreamStart(): void {
    this.streaming = true;
    dlog("onStreamStart");
  }
  async onStreamEnd(): Promise<void> {
    this.streaming = false;
    dlog("onStreamEnd");
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
    // This path is portable across Node/Bun; we prefer it when available.
    // Dedupe with onData by time (if both fire for the same physical key).
    const now = Date.now();

    // Ctrl+C → immediate
    if ((key.ctrl && key.name === "c") || key.sequence === "\x03") {
      dlog("keypress: Ctrl+C");
      try { this.statusLine("SIGINT"); } finally { process.exit(130); }
      return;
    }

    // ESC → graceful (defer if streaming)
    if (key.name === "escape" || key.sequence === "\u001b") {
      if (now - this.lastEscAt < 50) return; // dedupe
      this.lastEscAt = now;
      dlog("keypress: ESC");
      await this.handleEsc();
      return;
    }

    // 'i' → interject (interactive only)
    if ((key.name || "").toLowerCase() === this.interjectKeyName) {
      if (now - this.lastIAt < 50) return; // dedupe
      this.lastIAt = now;
      dlog("keypress: i");
      await this.handleInterjectHit();
      return;
    }
  };

  private onData = async (chunk: Buffer | string) => {
    // Fallback parser: raw bytes in raw mode.
    // Important: we do not write chunk to stdout (avoids '^[' leakage).
    try {
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (!buf || buf.length === 0) return;
      const now = Date.now();

      // Ctrl+C (ETX)
      if (buf[0] === 0x03) {
        dlog("data: Ctrl+C");
        try { this.statusLine("SIGINT"); } finally { process.exit(130); }
        return;
      }

      // Bare ESC (0x1b). We wait a hair (15ms) to avoid CSI mis-fire, but only if len==1
      if (buf.length === 1 && buf[0] === 0x1b) {
        if (now - this.lastEscAt < 50) return; // dedupe with keypress
        this.lastEscAt = now;
        dlog("data: ESC (single-byte)");
        await this.handleEsc();
        return;
      }

      // 'i' (0x69) in raw mode (single byte, not while prompting)
      if (buf.length === 1 && (buf[0] === 0x69 || buf[0] === 0x49)) {
        if (now - this.lastIAt < 50) return; // dedupe with keypress
        this.lastIAt = now;
        dlog("data: i");
        await this.handleInterjectHit();
        return;
      }

      // Multi-byte CSI (e.g., arrows): ignore; we only care about ESC/i/Ctrl+C.
      // dlog("data: ignored", JSON.stringify([...buf.slice(0, 8)]));
    } catch { /* ignore */ }
  };

  private async handleEsc(): Promise<void> {
    if (!this.opts.stdin.isTTY) return; // hotkeys disabled in non-interactive
    if (this.streaming) {
      this.shutdownRequested = true;
      this.statusLine(
        this.opts.waitOverlayMessage ??
          "⏳ ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)"
      );
      return;
    }
    await this.finalizeAndReviewAndExit();
  }

  private async handleInterjectHit(): Promise<void> {
    if (!this.opts.stdin.isTTY) return; // interactive only
    if (this.reading || this.interjecting) return;
    if (this.streaming) {
      this.interjectPending = true;
      this.statusLine("…waiting for model to finish before interjection");
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
    dlog(`promptOnce: "${label.trim()}"`);
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

  private async readLoop(): Promise<void> {
    dlog("readLoop: start");
    while (this.running) {
      const line = await this.promptOnce(this.opts.prompt);
      const txt = line.trim();
      if (txt.length === 0) continue;
      await this.scheduler?.enqueueUserText(txt);
    }
    dlog("readLoop: end");
  }
}

/* ------------------------- Module-level convenience ------------------------- */
/* Keep legacy `await ttyStart()` working; proxy to runtime-owned controller. */

const _default = new TtyController({
  stdin: process.stdin,
  stdout: process.stdout,
  prompt: "user: ",
  interjectKey: "i",
  interjectBanner: "user: ",
  feedbackStream: process.stderr,
  forceExclusive: true,
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

// API parity helpers (some legacy code calls these)
export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withCookedTTY(fn); }
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withRawTTY(fn); }

// Optional compatibility storage
let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }
