/**
 * TTY Controller
 * --------------
 * A small, well-scoped class that owns interactive TTY I/O.
 * - Provides a minimal state machine: "idle" → "reading" → "draining"/"closed".
 * - Buffers writes and flushes them at a configurable cadence to reduce flicker.
 * - Normalizes user input lines and keypresses (ESC for graceful exit, Ctrl+C for fast exit).
 *
 * This file is intentionally self-contained; it does not monkey-patch anything and
 * it does not rely on legacy names. Integration code can adapt as needed.
 *
 * Filename: src/input/tty-controller.ts
 */

import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import * as readline from "node:readline";
import { SchedulerLike } from "../scheduler/scheduler";
import { Logger } from "../logger";

// ————————————————————————————————————————————————————————————————————————————
// Types
// ————————————————————————————————————————————————————————————————————————————

export type TtyState = "idle" | "reading" | "draining" | "closed";

export interface Keypress {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface TtyControllerOptions {
  /** Message to show when user presses Esc while model is busy. */
  waitOverlayMessage?: string;            // default: "Waiting for agent to finish"
  /** Suppress writes (e.g., CoT stream) while overlay is active. */
  waitSuppressOutput?: boolean;           // default: true
  /** How fast to tick the dots animation. */
  waitOverlayIntervalMs?: number;         // default: 250

  stdin: Readable & Partial<NodeJS.ReadStream>;
  stdout: Writable & Partial<NodeJS.WriteStream>;
  scheduler?: SchedulerLike;
  /**
   * If true, the controller will write a newline after each flushed chunk
   * that does not already end with one. Default: false.
   */
  ensureTrailingNewline?: boolean;
  /**
   * Flush interval (ms). Buffers written via `write()` are coalesced and
   * emitted to stdout at this cadence. Default: 24ms.
   */
  flushIntervalMs?: number;
  /**
   * Hard cap for immediate flush when buffered bytes exceed this size.
   * Default: 4096 bytes.
   */
  flushHighWaterMark?: number;
  /**
   * Optional finalizer invoked during graceful shutdown (ESC).
   */
  finalizer?: () => void | Promise<void>;
  /**
   * Optional prompt string. When defined, it is re-rendered after each flush
   * while in "reading" state. Defaults to "User: ".
   */
  prompt?: string;
  interjectKey?: string;        // default: "i"
  interjectBanner?: string;     // default: "You: "
}

export interface TtyControllerEvents {
  state: (state: TtyState, prev: TtyState) => void;
  key: (key: Keypress) => void;
  line: (line: string) => void;
  flush: () => void;
  close: () => void;
}

// ————————————————————————————————————————————————————————————————————————————
// Implementation
// ————————————————————————————————————————————————————————————————————————————

export class TtyController extends EventEmitter {
  public state: TtyState = "idle";

  private readonly stdin: TtyControllerOptions["stdin"];
  private readonly stdout: TtyControllerOptions["stdout"];
  private readonly ensureTrailingNewline: boolean;
  private readonly flushIntervalMs: number;
  private readonly flushHighWaterMark: number;

  private scheduler?: SchedulerLike;
  private finalizer?: () => void | Promise<void>;
  private prompt: string | undefined;

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

  // Heuristic to detect "busy" output; updated on every write.
  private lastWriteAt = 0;

  constructor(opts: TtyControllerOptions) {
    super();
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    this.scheduler = opts.scheduler;
    this.finalizer = opts.finalizer;

    this.prompt = opts.prompt ?? "User: ";  // sensible default

    this.ensureTrailingNewline = !!opts.ensureTrailingNewline;
    this.flushIntervalMs = typeof opts.flushIntervalMs === "number" ? opts.flushIntervalMs : 24;
    this.flushHighWaterMark = typeof opts.flushHighWaterMark === "number" ? opts.flushHighWaterMark : 4096;

    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";

    this.waitOverlayMessage = opts.waitOverlayMessage ?? "Waiting for agent to finish";
    this.waitSuppressOutput = opts.waitSuppressOutput ?? true;
    this.waitOverlayIntervalMs = typeof opts.waitOverlayIntervalMs === "number" ? opts.waitOverlayIntervalMs : 250;
  }

  // ——————————————————————————————————————————————————————————
  // Lifecycle & configuration
  // ——————————————————————————————————————————————————————————

  public setScheduler(s: SchedulerLike | undefined) {
    this.scheduler = s;
  }

  public setFinalizer(f: (() => void | Promise<void>) | undefined) {
    this.finalizer = f;
  }

  public setPrompt(prompt: string | undefined) {
    this.prompt = prompt ?? "User: ";
    if (this.state === "reading") this.renderPrompt();
  }

  /**
   * Begin interactive processing. We do NOT pause; we resume stdin so keypress
   * events always fire, even while the model is thinking.
   */
  public start(): void {
    if (this.state !== "idle") return;

    readline.emitKeypressEvents(this.stdin as NodeJS.ReadStream);
    if ((this.stdin as NodeJS.ReadStream).isTTY?.valueOf?.() || (this.stdin as NodeJS.ReadStream).isTTY === true) {
      try { (this.stdin as NodeJS.ReadStream).setRawMode?.(true); } catch {}
      try { (this.stdin as NodeJS.ReadStream).resume?.(); } catch {}
    }

    (this.stdin as NodeJS.ReadStream).on("keypress", this.onKeypress);

    this.rl = readline.createInterface({
      input: this.stdin as Readable,
      crlfDelay: Infinity,
      terminal: (this.stdin as NodeJS.ReadStream).isTTY ?? false,
    });
    this.rl.on("line", this.onLine);

    this.transition("reading");
    this.renderPrompt();
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

    (this.stdin as NodeJS.ReadStream).off?.("keypress", this.onKeypress);
    this.rl?.off("line", this.onLine);
    this.rl?.close();
    this.rl = undefined;

    if ((this.stdin as NodeJS.ReadStream).isTTY) {
      try { (this.stdin as NodeJS.ReadStream).setRawMode?.(false); } catch {}
    }

    this.flush(true);
    this.transition("closed");
    this.emit("close");
  }

  // ——————————————————————————————————————————————————————————
  // Writing & flushing
  // ——————————————————————————————————————————————————————————

  public write(chunk: string | Buffer): void {
    if (this.state === "closed") return;

    // Track activity for busy/idle heuristic
    this.lastWriteAt = Date.now();

    // Drop output (e.g., CoT stream) while in wait overlay if requested
    if (this.waitOverlayActive && this.waitSuppressOutput) return;

    if (typeof chunk === "string" && this.ensureTrailingNewline && !chunk.endsWith("\n")) {
      chunk = chunk + "\n";
    }
    this.outBuf.push(chunk);
    this.outSize += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;

    if (this.outSize >= this.flushHighWaterMark) {
      this.flush(true);
    } else {
      this.scheduleFlush();
    }
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

    if (this.state === "reading") this.renderPrompt();
  }

  private scheduleFlush() {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(true), this.flushIntervalMs);
    }
  }

  // ——————————————————————————————————————————————————————————
  // Interjection helpers
  // ——————————————————————————————————————————————————————————

  private beginInterject() {
    this.hideWaitOverlay();
    if (this.state === "closed" || this.interjectActive) return;
    this.interjectActive = true;
    this.stdout.write("\n");
    (this.rl as any)?.setPrompt?.(this.interjectBanner);
    this.rl?.resume();
    (this.rl as any)?.prompt?.();
  }

  private endInterject() {
    if (!this.interjectActive) return;
    this.interjectActive = false;
    this.interjectDoneResolve?.();   // resolve askUser() promise if any
    this.interjectDoneResolve = null;
    this.renderPrompt();
  }

  private renderPrompt() {
    if (!this.prompt) return;
    const out = this.stdout as Partial<NodeJS.WriteStream>;
    if (out.clearLine && out.cursorTo) {
      out.clearLine(0);
      out.cursorTo(0);
      this.stdout.write(this.prompt);
    } else {
      this.stdout.write(this.prompt);
    }
  }

  // ——————————————————————————————————————————————————————————
  // Input handling
  // ——————————————————————————————————————————————————————————

  private onLine = async (line: string) => {
    // TRACE: prove we captured a line and are about to enqueue it
    if (process.env.ORG_TRACE === "1") {
      Logger.info(`[TRACE] tty.onLine`, { line });
    }

    // Accept empty lines too — the scheduler policy can decide to ignore them
    const s = this.scheduler;
    try {
      if (s?.enqueueUserText)       await s.enqueueUserText(line);
      else if (s?.enqueue)          await s.enqueue({ role: "user", content: line });
      else if (s?.send)             await s.send(line);
      else                          this.emit("line", line);
    } finally {
      this.endInterject(); // resolves askUser() if active; no-op otherwise
    }
  };

  private onKeypress = async (_: string, key: Keypress) => {
    this.emit("key", key);

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

    if (key?.name === "c" && key.ctrl) {
      await this.close(false);
      return;
    }

    // Auto-enter interjection on first printable char and keep it
    if (!this.interjectActive && !key.ctrl && !key.meta) {
      const ch = (key.sequence ?? key.name ?? "");
      if (ch && ch.length === 1 && ch !== "\r" && ch !== "\n") {
        this.beginInterject();
        this.rl?.write(ch);
        return;
      }
    }

    // Explicit interjection hotkey (default: 'i')
    if (!key.ctrl && !key.meta) {
      const k = (key.name ?? key.sequence ?? "").toLowerCase();
      if (k === this.interjectKey) {
        this.beginInterject();
        return;
      }
    }
  };

  // ——————————————————————————————————————————————————————————
  // Helpers
  // ——————————————————————————————————————————————————————————

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
    const header = fromAgent ? `[${fromAgent}] ` : "";
    this.write(`\n${header}${content}\n`);
    return new Promise<void>((resolve) => {
      this.interjectDoneResolve = resolve;
      this.beginInterject();
    });
  }
}

export default TtyController;
