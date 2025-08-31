// src/input/tty-controller.ts
// Runtime-owned TTY controller with portable hotkeys and a stdout guard.
// - Primary hotkeys via 'keypress' (works in Bun/Node), fallback via raw 'data'
// - ESC: graceful (defer if streaming, then finalize+review); 'i': interject
// - Immediate feedback to stderr so it never competes with tokens
// - Non-interactive (no TTY): hotkeys disabled automatically
// - Optional stdout guard: ORG_STDOUT_GUARD=1 (log) | "throw" (crash on ESC to stdout)

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";
import { Logger } from "../logger";
import { R } from "../runtime/runtime";

/* -------------------------------- Debug flags ------------------------------- */

const TTY_DEBUG =
  (typeof process !== "undefined" &&
    (process.env.ORG_TTY_DEBUG === "1" ||
     process.env.DEBUG_TTY === "1" ||
     process.env.DEBUG === "tty")) || false;

function dlog(...args: any[]) {
  if (!TTY_DEBUG) return;
  try { (process.stderr || console).write(`[tty] ${args.join(" ")}\n`); } catch { /* ignore */ }
}

/* ------------------------------ Stdout guard -------------------------------- */

type GuardMode = "off" | "log" | "throw";

function resolveGuardMode(): GuardMode {
  return "throw";
  const v = (process.env.ORG_STDOUT_GUARD || "").toLowerCase().trim();
  if (v === "1" || v === "log") return "log";
  if (v === "throw" || v === "crash" || v === "hard") return "throw";
  return "off";
}

function chunkHasEsc(chunk: unknown): boolean {
  if (chunk == null) return false;
  if (Buffer.isBuffer(chunk)) return chunk.includes(0x1b); // ESC
  const s = String(chunk);
  return s.indexOf("\u001b") !== -1;
}

function printablePreview(chunk: unknown, max = 160): string {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  let out = "";
  for (let i = 0; i < buf.length && out.length < max; i++) {
    const b = buf[i]!;
    if (b === 0x1b) out += "^[";
    else if (b === 0x0a) out += "\\n";
    else if (b === 0x0d) out += "\\r";
    else if (b < 0x20 || b === 0x7f) out += `\\x${b.toString(16).padStart(2, "0")}`;
    else out += String.fromCharCode(b);
  }
  return out;
}

function installStdoutGuard(mode: GuardMode): () => void {
  if (mode === "off") return () => {};
  const stdout: any = process.stdout;
  const origWrite = stdout.write.bind(stdout);

  const patched = function writePatched(
    chunk: any,
    encoding?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void
  ) {
    if (chunkHasEsc(chunk)) {
      const prev = printablePreview(chunk);
      const tag = `[stdout-guard:${mode}] ESC byte detected in write(); preview="${prev}"\n`;
      try {
        (process.stderr || console).write(tag + (new Error().stack || "") + "\n");
      } catch { /* ignore */ }
      if (mode === "throw") {
        try {
          throw new Error("stdout-guard: ESC byte written to stdout");
        }
        catch (e) {
          console.log('ESCAPE DETECTED');
          console.log(e);
        }
      }
    }
    return origWrite(chunk, encoding as any, cb);
  };

  stdout.write = patched;
  dlog(`stdout-guard installed (mode=${mode})`);
  return () => { try { stdout.write = origWrite; } catch { /* ignore */ } };
}

/* ----------------------------- Types & helpers ------------------------------ */

export interface TtyControllerOptions {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  prompt: string;            // banner for idle prompt (trailing space enforced)
  interjectKey: string;      // key name, default 'i'
  interjectBanner: string;   // banner for interjection prompt
  waitOverlayMessage?: string;
  finalizer?: () => Promise<void> | void;
  loopMode?: "controller" | "external";
  feedbackStream?: NodeJS.WriteStream;
  forceExclusive?: boolean;  // remove other keypress listeners if true
}

function hasSetRawMode(s: NodeJS.ReadStream): s is TtyReadStream {
  return typeof (s as { setRawMode?: unknown }).setRawMode === "function";
}

/* -------------------------------- Controller -------------------------------- */

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
  private uninstallGuard: (() => void) | null = null;

  // dedupe if both keypress and data fire for same key
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

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Optional stdout guard (dev-only)
    const gm = resolveGuardMode();
    if (!this.uninstallGuard && gm !== "off") {
      this.uninstallGuard = installStdoutGuard(gm);
    }

    const { stdin } = this.opts;
    if (!stdin.isTTY) {
      dlog("start: no TTY → hotkeys disabled");
      return;
    }

    try { emitKeypressEvents(stdin as any); dlog("emitKeypressEvents OK"); } catch { dlog("emitKeypressEvents failed"); }
    try { hasSetRawMode(stdin) && stdin.setRawMode!(true); dlog("setRawMode(true)"); } catch { dlog("setRawMode failed"); }
    try { (stdin as any).resume?.(); dlog("stdin.resume()"); } catch { /* ignore */ }

    if (this.opts.forceExclusive) {
      try {
        const existing = (stdin as any).rawListeners?.("keypress") ?? (stdin as any).listeners?.("keypress") ?? [];
        if (existing.length > 0) dlog(`forceExclusive: removing ${existing.length} prior keypress listeners`);
        for (const fn of existing) { try { (stdin as any).off?.("keypress", fn); } catch { /* ignore */ } }
      } catch { /* ignore */ }
    }

    if (!this.keypressBound) {
      (stdin as any).on("keypress", this.onKeypress);
      this.keypressBound = true;
      dlog("keypress handler bound");
    }
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
      try { (stdin as any).off?.("keypress", this.onKeypress); this.keypressBound = false; } catch {}
      try { (stdin as any).off?.("data", this.onData); this.dataBound = false; } catch {}
      try { hasSetRawMode(stdin) && stdin.setRawMode!(false); dlog("setRawMode(false)"); } catch {}
    }

    if (this.uninstallGuard) { try { this.uninstallGuard(); } catch {} this.uninstallGuard = null; }

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

  onStreamStart(): void { this.streaming = true; dlog("onStreamStart"); }
  async onStreamEnd(): Promise<void> {
    this.streaming = false; dlog("onStreamEnd");
    if (this.shutdownRequested) { this.shutdownRequested = false; await this.finalizeAndReviewAndExit(); return; }
    if (this.interjectPending) { this.interjectPending = false; await this.openInterjectionPromptOnce(); }
  }

  /* -------------------------------- Handlers -------------------------------- */

  private onKeypress = async (_: string, key: Key) => {
    const now = Date.now();

    if ((key.ctrl && key.name === "c") || key.sequence === "\x03") {
      dlog("keypress: Ctrl+C");
      try { this.statusLine("SIGINT"); } finally { process.exit(130); }
      return;
    }

    if (key.name === "escape" || key.sequence === "\u001b") {
      if (now - this.lastEscAt < 50) return;
      this.lastEscAt = now;
      dlog("keypress: ESC");
      await this.handleEsc();
      return;
    }

    if ((key.name || "").toLowerCase() === this.interjectKeyName) {
      if (now - this.lastIAt < 50) return;
      this.lastIAt = now;
      dlog("keypress: i");
      await this.handleInterjectHit();
      return;
    }
  };

  private onData = async (chunk: Buffer | string) => {
    try {
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (!buf || buf.length === 0) return;
      const now = Date.now();

      if (buf[0] === 0x03) { // ETX
        dlog("data: Ctrl+C");
        try { this.statusLine("SIGINT"); } finally { process.exit(130); }
        return;
      }

      if (buf.length === 1 && buf[0] === 0x1b) {
        if (now - this.lastEscAt < 50) return;
        this.lastEscAt = now;
        dlog("data: ESC");
        await this.handleEsc();
        return;
      }

      if (buf.length === 1 && (buf[0] === 0x69 || buf[0] === 0x49)) {
        if (now - this.lastIAt < 50) return;
        this.lastIAt = now;
        dlog("data: i");
        await this.handleInterjectHit();
        return;
      }
      // ignore CSI etc.
    } catch { /* ignore */ }
  };

  private async handleEsc(): Promise<void> {
    if (!this.opts.stdin.isTTY) return;
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
    if (!this.opts.stdin.isTTY) return;
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
      await this.unwind(); // runs finalizer (stop→drain→review)
      process.exit(0);
    } catch (err) {
      Logger.warn(`Finalize/review failed: ${String(err)}`);
      try { await this.unwind(); } catch {}
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
      try { return await rl.question(label); }
      finally { rl.close(); }
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

/* ---------------------- Module-level compatibility layer -------------------- */

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
