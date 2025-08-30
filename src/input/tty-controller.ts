/**
 * TTY Controller
 * --------------
 * Predictable REPL I/O:
 * - ESC (graceful), Ctrl+C (fast)
 * - normal typing and Enter (no duplicated first char, no stray newline)
 * - explicit interjection only via askUser() or hotkey
 *
 * Enable ORG_TRACE=1 to see:
 *   [TRACE] tty.data        — raw bytes arriving on stdin
 *   [TRACE] tty.keypress    — keypress events (readline emitKeypressEvents)
 *   [TRACE] tty.onLine      — when a line is submitted (Enter)
 *   [TRACE] tty.askUser     — when the scheduler triggers an interjection
 */

import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import * as readline from "node:readline";
import { SchedulerLike } from "../scheduler/scheduler";
import { Logger } from "../logger";

export type TtyState = "idle" | "reading" | "draining" | "closed";

export interface Keypress {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface TtyControllerOptions {
  waitOverlayMessage?: string;            // default: "Waiting for agent to finish"
  waitSuppressOutput?: boolean;           // default: true
  waitOverlayIntervalMs?: number;         // default: 250
  stdin: Readable & Partial<NodeJS.ReadStream>;
  stdout: Writable & Partial<NodeJS.WriteStream>;
  scheduler?: SchedulerLike;
  ensureTrailingNewline?: boolean;        // default: false
  flushIntervalMs?: number;               // default: 24
  flushHighWaterMark?: number;            // default: 4096
  finalizer?: () => void | Promise<void>;
  prompt?: string;                        // label; default "You: "
  interjectBanner?: string;               // label used during askUser(); default "You: "
  interjectKey?: string;                  // hotkey to enter interjection explicitly; default "i"
}

export interface TtyControllerEvents {
  state: (state: TtyState, prev: TtyState) => void;
  key: (key: Keypress) => void;
  line: (line: string) => void;
  flush: () => void;
  close: () => void;
}

export class TtyController extends EventEmitter {
  public state: TtyState = "idle";

  private readonly stdin: TtyControllerOptions["stdin"];
  private readonly stdout: TtyControllerOptions["stdout"];
  private readonly ensureTrailingNewline: boolean;
  private readonly flushIntervalMs: number;
  private readonly flushHighWaterMark: number;

  private scheduler?: SchedulerLike;
  private finalizer?: () => void | Promise<void>;
  private prompt: string;

  private rl?: readline.Interface;
  private outBuf: (string | Buffer)[] = [];
  private outSize = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  private interjectKey: string;
  private interjectBanner: string;
  private interjectActive = false;
  private interjectDoneResolve: (() => void) | null = null;

  private waitOverlayActive = false;
  private waitOverlayTimer: NodeJS.Timeout | null = null;
  private waitOverlayDots = 0;

  private waitOverlayMessage: string;
  private waitSuppressOutput: boolean;
  private waitOverlayIntervalMs: number;

  private lastWriteAt = 0;

  private dataListener?: (chunk: Buffer | string) => void;

  constructor(opts: TtyControllerOptions) {
    super();
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    this.scheduler = opts.scheduler;
    this.finalizer = opts.finalizer;

    this.prompt = opts.prompt ?? "You: ";
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();

    this.ensureTrailingNewline = !!opts.ensureTrailingNewline;
    this.flushIntervalMs = typeof opts.flushIntervalMs === "number" ? opts.flushIntervalMs : 24;
    this.flushHighWaterMark = typeof opts.flushHighWaterMark === "number" ? opts.flushHighWaterMark : 4096;

    this.waitOverlayMessage = opts.waitOverlayMessage ?? "Waiting for agent to finish";
    this.waitSuppressOutput = opts.waitSuppressOutput ?? true;
    this.waitOverlayIntervalMs =
      typeof opts.waitOverlayIntervalMs === "number" ? opts.waitOverlayIntervalMs : 250;
  }

  public setScheduler(s: SchedulerLike | undefined) { this.scheduler = s; }
  public setFinalizer(f: (() => void | Promise<void>) | undefined) { this.finalizer = f; }

  public setPrompt(prompt: string | undefined) {
    this.prompt = prompt ?? "You: ";
    if (this.state === "reading") this.renderPrompt();
  }

  public start(): void {
    if (this.state !== "idle") return;

    const isTrace = process.env.ORG_TRACE === "1";
    const rs = this.stdin as NodeJS.ReadStream;

    readline.emitKeypressEvents(rs);
    if (rs.isTTY?.valueOf?.() || rs.isTTY === true) {
      try { rs.setRawMode?.(true); } catch {}
      try { rs.resume?.(); } catch {}
    }

    if (isTrace) {
      this.dataListener = (chunk: Buffer | string) => {
        const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const preview = b.length <= 16 ? b.toString("hex")
          : b.subarray(0, 16).toString("hex") + `…(+${b.length - 16})`;
        Logger.info(`[TRACE] tty.data len=${b.length} hex=${preview}`);
      };
      rs.on("data", this.dataListener);
    }

    rs.on("keypress", this.onKeypress);

    this.rl = readline.createInterface({
      input: this.stdin as Readable,
      output: this.stdout as Writable,
      crlfDelay: Infinity,
      terminal: rs.isTTY ?? false,
    });

    readline.emitKeypressEvents(rs, this.rl);
    this.rl.setPrompt(this.prompt);
    (this.rl as any).prompt(true);

    this.rl.on("line", this.onLine);

    this.transition("reading");
  }

  public async close(graceful = false): Promise<void> {
    this.hideWaitOverlay();
    if (this.state === "closed") return;

    if (graceful) {
      this.transition("draining");
      try { await this.scheduler?.stop?.(); } catch {}
      try { await this.scheduler?.drain?.(); } catch {}
      try { await this.finalizer?.(); } catch {}
    }

    const rs = this.stdin as NodeJS.ReadStream;
    rs.off?.("keypress", this.onKeypress);
    if (this.dataListener) rs.off?.("data", this.dataListener);
    this.dataListener = undefined;

    this.rl?.off("line", this.onLine);
    this.rl?.close();
    this.rl = undefined;

    if (rs.isTTY) {
      try { rs.setRawMode?.(false); } catch {}
    }

    this.flush(true);
    this.transition("closed");
    this.emit("close");
  }

  // ---------- output buffering ----------

  public write(chunk: string | Buffer): void {
    if (this.state === "closed") return;

    this.lastWriteAt = Date.now();
    if (this.waitOverlayActive && this.waitSuppressOutput) return;

    if (typeof chunk === "string" && this.ensureTrailingNewline && !chunk.endsWith("\n")) {
      chunk = chunk + "\n";
    }

    this.outBuf.push(chunk);
    this.outSize += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;

    if (this.outSize >= this.flushHighWaterMark) this.flush(true);
    else this.scheduleFlush();
  }

  public flush(now = false): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.outBuf.length === 0) return;

    const data = Buffer.isBuffer(this.outBuf[0])
      ? Buffer.concat(this.outBuf as Buffer[])
      : Buffer.from((this.outBuf as string[]).join(""));

    this.outBuf.length = 0;
    this.outSize = 0;

    this.stdout.write(data);
    this.emit("flush");

    if (this.state === "reading" && this.rl) (this.rl as any).prompt(true);
  }

  private scheduleFlush() {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(true), this.flushIntervalMs);
    }
  }

  // ---------- interjection ----------

  private beginInterject() {
    this.hideWaitOverlay();
    if (this.state === "closed" || this.interjectActive) return;
    this.interjectActive = true;
    if (this.rl) {
      this.stdout.write("\n");
      (this.rl as any).setPrompt?.(this.interjectBanner);
      (this.rl as any).prompt?.();
    }
  }

  private endInterject() {
    if (!this.interjectActive) return;
    this.interjectActive = false;
    this.interjectDoneResolve?.();
    this.interjectDoneResolve = null;
    if (this.rl) {
      (this.rl as any).setPrompt?.(this.prompt);
      (this.rl as any).prompt?.(true);
    }
  }

  private renderPrompt() {
    if (this.rl) {
      (this.rl as any).setPrompt?.(this.prompt);
      (this.rl as any).prompt?.(true);
    } else {
      this.stdout.write(this.prompt);
    }
  }

  // ---------- input handling ----------

  private onLine = async (line: string) => {
    if (process.env.ORG_TRACE === "1") {
      Logger.info(`[TRACE] tty.onLine`, { line });
    }

    const s = this.scheduler;
    try {
      if (s?.enqueueUserText)       await s.enqueueUserText(line);
      else if (s?.enqueue)          await s.enqueue({ role: "user", content: line });
      else if (s?.send)             await s.send(line);
      else                          this.emit("line", line);
    } finally {
      this.endInterject();
    }
  };

  private onKeypress = async (_: string, key: Keypress) => {
    if (process.env.ORG_TRACE === "1") {
      Logger.info(`[TRACE] tty.keypress`, key);
    }

    // ESC
    if (key?.name === "escape") {
      if (this.interjectActive) {
        await this.close(true);
      } else {
        const recentlyBusy =
          (Date.now() - this.lastWriteAt) < 1000 ||
          this.outBuf.length > 0 ||
          !!this.flushTimer;
        if (recentlyBusy) this.showWaitOverlay();
      }
      return;
    }

    // Ctrl+C => fast exit
    if (key?.name === "c" && key.ctrl) {
      await this.close(false);
      return;
    }

    // (No auto-interject on first key.) Explicit hotkey only:
    if (!key.ctrl && !key.meta) {
      const k = (key.name ?? key.sequence ?? "").toLowerCase();
      if (k === this.interjectKey) {
        this.beginInterject();
        return;
      }
    }
  };

  // ---------- helpers ----------

  private transition(next: TtyState) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.emit("state", next, prev);
  }

  private showWaitOverlay() {
    if (this.waitOverlayActive) return;
    this.waitOverlayActive = true;
    this.waitOverlayDots = 0;

    const out = this.stdout as Partial<NodeJS.WriteStream>;
    this.stdout.write("\n");
    const draw = () => {
      const dots = ".".repeat((this.waitOverlayDots++ % 10) + 1);
      const msg = `${this.waitOverlayMessage} ${dots}`;
      if (out.clearLine && out.cursorTo) { out.clearLine(0); out.cursorTo(0); this.stdout.write(msg); }
      else { this.stdout.write(`\r${msg}`); }
    };
    draw();
    this.waitOverlayTimer = setInterval(draw, this.waitOverlayIntervalMs);
  }

  private hideWaitOverlay() {
    if (!this.waitOverlayActive) return;
    if (this.waitOverlayTimer) { clearInterval(this.waitOverlayTimer); this.waitOverlayTimer = null; }
    this.waitOverlayActive = false;

    const out = this.stdout as Partial<NodeJS.WriteStream>;
    if (out.clearLine && out.cursorTo) { out.clearLine(0); out.cursorTo(0); }
    this.stdout.write("\n");
  }

  public async askUser(fromAgent: string, content: string): Promise<void> {
    if (process.env.ORG_TRACE === "1") {
      Logger.info(`[TRACE] tty.askUser`, { fromAgent, content });
    }
    const header = fromAgent ? `[${fromAgent}] ` : "";
    this.write(`\n${header}${content}\n`);
    return new Promise<void>((resolve) => {
      this.interjectDoneResolve = resolve;
      this.beginInterject();
    });
  }
}

export default TtyController;




// src/input/tty-controller.ts
// Centralized, type-safe TTY state management with scoped transitions.
// No external side-effects beyond toggling raw/cooked on the provided stream.

export type TtyMode = "raw" | "cooked";

/**
 * Minimal surface we need from a TTY-like input stream.
 * NodeJS.ReadStream conforms structurally, and test doubles can too.
 */
export type TtyIn = Pick<NodeJS.ReadStream, "isTTY"> &
  Partial<Pick<NodeJS.ReadStream, "setRawMode" | "isRaw">>;

export class TtyControllerNew {
  private readonly tty: TtyIn;

  /**
   * Mode stack allows safe nesting (re-entrant scopes). The top of the stack
   * reflects the mode *before* the current scope was entered.
   */
  private readonly modeStack: TtyMode[] = [];

  /** Our current view of the stream's mode. */
  private current: TtyMode;

  constructor(tty: TtyIn) {
    this.tty = tty;
    this.current = this.detectInitialMode(tty);
  }

  /** Returns the controller's view of the current mode. */
  get mode(): TtyMode {
    return this.current;
  }

  /** Enter a cooked TTY scope and restore the previous mode afterwards. */
  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withScopedMode("cooked", fn);
  }

  /** Enter a raw TTY scope and restore the previous mode afterwards. */
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withScopedMode("raw", fn);
  }

  /**
   * For advanced callers (tests, adapters). Generally prefer the scoped helpers above.
   * Public to make adoption incremental; we can tighten later if desired.
   */
  setMode(next: TtyMode): void {
    if (!this.tty.isTTY || typeof this.tty.setRawMode !== "function") {
      // Non-TTY or no toggling available: just update our local view.
      this.current = next;
      return;
    }

    const wantRaw = next === "raw";
    const isRaw = this.tty.isRaw === true; // Node sets this when in raw mode.

    if (wantRaw && !isRaw) {
      this.tty.setRawMode(true);
    } else if (!wantRaw && isRaw) {
      this.tty.setRawMode(false);
    }

    this.current = next;
  }

  // ---------- Internals ----------

  private detectInitialMode(tty: TtyIn): TtyMode {
    if (!tty.isTTY) return "cooked";
    // Node's ReadStream exposes .isRaw when toggled; if absent, assume cooked.
    return tty.isRaw ? "raw" : "cooked";
  }

  private async withScopedMode<T>(
    next: TtyMode,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    this.modeStack.push(this.current);
    try {
      this.setMode(next);
      return await fn();
    } finally {
      const prev = this.modeStack.pop() ?? "cooked";
      this.setMode(prev);
    }
  }
}

/**
 * Default controller bound to process.stdin.
 * Kept as a convenience; callers may also construct their own with a custom stream.
 */
//export const defaultTtyController = new TtyController(process.stdin);
