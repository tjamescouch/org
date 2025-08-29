/**
 * TTY Controller
 * --------------
 * A small, well-scoped class that owns interactive TTY I/O.
 * - Provides a minimal state machine: "idle" → "reading" → "draining"/"closed".
 * - Buffered output with periodic flush to reduce flicker.
 * - Predictable keys: ESC (graceful), Ctrl+C (fast), normal REPL typing/Enter.
 *
 * When ORG_TRACE=1, we emit trace logs for raw data, keypress, and line.
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

  /** Prompt label shown by readline during normal REPL mode. Default: "User: ". */
  prompt?: string;
  /** One-shot banner when entering askUser()/interjection. Default: "You: ". */
  interjectBanner?: string;
  /** Hotkey to enter interjection explicitly. Default: "i". */
  interjectKey?: string;
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

  // listeners so we can cleanly detach
  private dataListener?: (chunk: Buffer | string) => void;

  constructor(opts: TtyControllerOptions) {
    super();
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    this.scheduler = opts.scheduler;
    this.finalizer = opts.finalizer;

    this.prompt = opts.prompt ?? "User: ";
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
    this.prompt = prompt ?? "User: ";
    if (this.state === "reading") this.renderPrompt();
  }

  /**
   * Start interactive I/O. Important details:
   * - readline is created with both input and output so typed chars echo.
   * - we set the prompt on the readline interface and call rl.prompt(true).
   * - we *do not* pause stdin; we resume it so keypress/data fire consistently.
   */
  public start(): void {
    if (this.state !== "idle") return;

    const isTrace = process.env.ORG_TRACE === "1";
    const rs = this.stdin as NodeJS.ReadStream;

    // Keypress events
    readline.emitKeypressEvents(rs);

    // Raw mode and resume so 'data' and 'keypress' actually flow
    if (rs.isTTY?.valueOf?.() || rs.isTTY === true) {
      try { rs.setRawMode?.(true); } catch {}
      try { rs.resume?.(); } catch {}
    }

    // Optional raw byte trace
    if (isTrace) {
      this.dataListener = (chunk: Buffer | string) => {
        const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const preview = b.length <= 16 ? b.toString("hex") : b.subarray(0, 16).toString("hex") + `…(+${b.length - 16})`;
        Logger.info(`[TRACE] tty.data len=${b.length} hex=${preview}`);
      };
      rs.on("data", this.dataListener);
    }

    rs.on("keypress", this.onKeypress);

    // Create readline with BOTH input and output so local echo works
    this.rl = readline.createInterface({
      input: this.stdin as Readable,
      output: this.stdout as Writable,
      crlfDelay: Infinity,
      terminal: rs.isTTY ?? false,
    });

    // Now (re)bind keypress to the interface context too
    readline.emitKeypressEvents(rs, this.rl);

    // Show the initial prompt under readline's control
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

  // ------------------------- output buffering -------------------------

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

    // Re-render rl prompt if present
    if (this.state === "reading" && this.rl) (this.rl as any).prompt(true);
  }

  private scheduleFlush() {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(true), this.flushIntervalMs);
    }
  }

  // ------------------------- interjection/session -------------------------

  private beginInterject() {
    this.hideWaitOverlay();
    if (this.state === "closed" || this.interjectActive) return;
    this.interjectActive = true;
    if (this.rl) {
      // NOTE: we do not insert a leading newline unless askUser() requested it.
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
    // restore main prompt
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

  // ------------------------- input handling -------------------------

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

    this.emit("key", key);

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

    // EXPLICIT interjection hotkey only (no auto-interject on first key)
    if (!key.ctrl && !key.meta) {
      const k = (key.name ?? key.sequence ?? "").toLowerCase();
      if (k === this.interjectKey) {
        this.beginInterject();
        return;
      }
    }
  };

  // ------------------------- helpers -------------------------

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

  // Ask user one-off
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
