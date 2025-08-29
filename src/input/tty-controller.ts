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

export interface SchedulerLike {
  // Suggested (but optional) methods the application scheduler may expose.
  enqueue?(item: { role: "user"; content: string }): void | Promise<void>;
  enqueueUserText?(text: string): void | Promise<void>;
  send?(text: string): void | Promise<void>;
  stop?(): void | Promise<void>;
  drain?(): void | Promise<boolean>;
  stopDraining?(): void | Promise<void>;
  isDraining?(): boolean;
  handleUserInterjection?(text: string): void | Promise<void>;
}

export interface TtyControllerOptions {
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
   * while in "reading" state.
   */
  prompt?: string;
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

  constructor(opts: TtyControllerOptions) {
    super();
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    this.scheduler = opts.scheduler;
    this.finalizer = opts.finalizer;
    this.prompt = opts.prompt;

    this.ensureTrailingNewline = !!opts.ensureTrailingNewline;
    this.flushIntervalMs = typeof opts.flushIntervalMs === "number" ? opts.flushIntervalMs : 24;
    this.flushHighWaterMark = typeof opts.flushHighWaterMark === "number" ? opts.flushHighWaterMark : 4096;
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
    this.prompt = prompt;
    if (this.state === "reading") this.renderPrompt();
  }

  /**
   * Begin interactive processing. This attaches listeners and transitions
   * the controller to the "reading" state.
   */
  public start(): void {
    if (this.state !== "idle") return;

    // Keypress support
    readline.emitKeypressEvents(this.stdin as NodeJS.ReadStream);
    // Only set raw mode when we truly have a TTY.
    if ((this.stdin as NodeJS.ReadStream).isTTY?.valueOf?.() || (this.stdin as NodeJS.ReadStream).isTTY === true) {
      try {
        (this.stdin as NodeJS.ReadStream).setRawMode?.(true);
      } catch {
        /* ignore for non-ttys */
      }
    }

    (this.stdin as NodeJS.ReadStream).on("keypress", this.onKeypress);
    // Line-reader for normal input
    this.rl = readline.createInterface({
      input: this.stdin as Readable,
      crlfDelay: Infinity,
      terminal: (this.stdin as NodeJS.ReadStream).isTTY ?? false,
    });
    this.rl.on("line", this.onLine);

    this.transition("reading");
    this.renderPrompt();
  }

  /**
   * Stop reading and close resources. If `graceful` is true, try to stop and
   * drain the scheduler before closing and call the finalizer.
   */
  public async close(graceful = false): Promise<void> {
    if (this.state === "closed") return;

    if (graceful) {
      this.transition("draining");
      try {
        await this.scheduler?.stop?.();
        await this.scheduler?.drain?.();
        await this.finalizer?.();
      } catch {
        // intentionally swallow errors during shutdown
      }
    }

    // Detach listeners
    (this.stdin as NodeJS.ReadStream).off?.("keypress", this.onKeypress);
    this.rl?.off("line", this.onLine);
    this.rl?.close();
    this.rl = undefined;

    // Restore cooked mode if we enabled raw mode
    if ((this.stdin as NodeJS.ReadStream).isTTY) {
      try {
        (this.stdin as NodeJS.ReadStream).setRawMode?.(false);
      } catch { /* ignore */ }
    }

    this.flush(true);
    this.transition("closed");
    this.emit("close");
  }

  // ——————————————————————————————————————————————————————————
  // Writing & flushing
  // ——————————————————————————————————————————————————————————

  /**
   * Buffered write. Data is coalesced and flushed on a timer to minimize flicker.
   */
  public write(chunk: string | Buffer): void {
    if (this.state === "closed") return;
    if (typeof chunk === "string" && this.ensureTrailingNewline && !chunk.endsWith("\n")) {
      chunk = chunk + "\n";
    }
    this.outBuf.push(chunk);
    this.outSize += Buffer.byteLength(chunk as string);
    if (this.outSize >= this.flushHighWaterMark) {
      this.flush(true);
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Force a flush immediately (or schedule when `now` is false).
   */
  public flush(now = false): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.outBuf.length === 0) return;

    const data = Buffer.isBuffer(this.outBuf[0])
      ? Buffer.concat(this.outBuf as Buffer[])
      : Buffer.from((this.outBuf as string[]).join(""));

    this.outBuf.length = 0;
    this.outSize = 0;

    this.stdout.write(data);
    this.emit("flush");

    // Keep prompt visible in interactive mode
    if (this.state === "reading") this.renderPrompt();
  }

  private scheduleFlush() {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(true), this.flushIntervalMs);
    }
  }

  private renderPrompt() {
    if (!this.prompt) return;
    const out = this.stdout as Partial<NodeJS.WriteStream>;
    // If terminal, re-render on a new line.
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
    // Forward to the best available scheduler method; otherwise just emit.
    const s = this.scheduler;
    if (s?.enqueueUserText) await s.enqueueUserText(line);
    else if (s?.enqueue) await s.enqueue({ role: "user", content: line });
    else if (s?.send) await s.send(line);
    else this.emit("line", line);
  };

  private onKeypress = async (_: string, key: Keypress) => {
    this.emit("key", key);

    // ESC => graceful shutdown
    if (key?.name === "escape") {
      await this.close(true);
      return;
    }
    // Ctrl+C => fast exit
    if (key?.name === "c" && key.ctrl) {
      await this.close(false);
      return;
    }

    // Let the scheduler know that a user intervened (if supported)
    if (this.scheduler?.handleUserInterjection) {
      try {
        await this.scheduler.handleUserInterjection(key.sequence ?? key.name ?? "");
      } catch {
        /* ignore */
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

  // Typed overloads for EventEmitter
  override on<U extends keyof TtyControllerEvents>(event: U, listener: TtyControllerEvents[U]): this;
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
  override off<U extends keyof TtyControllerEvents>(event: U, listener: TtyControllerEvents[U]): this;
  override off(event: string, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
  override emit<U extends keyof TtyControllerEvents>(event: U, ...args: Parameters<TtyControllerEvents[U]>): boolean;
  override emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}

export default TtyController;
