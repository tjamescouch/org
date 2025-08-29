// src/input/controller.ts
import { EventEmitter } from "events";

export interface InputControllerOptions {
  /** When true (default), a *lone* ESC triggers the 'escape' event (outside passthrough). */
  exitOnEsc?: boolean;
  /** How long to wait for a 2nd byte before declaring a lone ESC (ms). Default 35ms. */
  loneEscDelayMs?: number;
}

export class InputController extends EventEmitter {
  private opts: Required<InputControllerOptions>;
  private passthrough = false;

  private escTimer: NodeJS.Timeout | null = null;
  private pendingEsc: Buffer | null = null;

  constructor(options?: InputControllerOptions) {
    super();
    this.opts = {
      exitOnEsc: options?.exitOnEsc ?? true,
      loneEscDelayMs: Math.max(0, options?.loneEscDelayMs ?? 35),
    };
  }

  /** Enable/disable app-level interception; when true, we forward everything raw. */
  public setPassthrough(on: boolean) {
    // Flush any pending ESC decision when switching modes
    this.flushPendingEscAsData();
    this.passthrough = !!on;
  }


  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachScheduler(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this: any,
    scheduler: SchedulerLike
  ) {
    this.scheduler = scheduler;
    if (typeof this.setScheduler === "function") {
      this.setScheduler(scheduler);
    }
    return this;
  };

  /** Entry-point for raw bytes coming from TTY. */
  public feed(buf: Buffer) {
    try {
      if (this.passthrough) {
        this.flushPendingEscAsData();
        this.emit("data", buf);
        return;
      }
      this.processWithEscDiscrimination(buf);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ---------------- private helpers ----------------

  private processWithEscDiscrimination(buf: Buffer) {
    if (this.pendingEsc) {
      this.cancelEscTimer();
      const combo = Buffer.concat([this.pendingEsc, buf]);
      this.pendingEsc = null;
      this.emit("data", combo);
      return;
    }

    if (buf.length === 1 && buf[0] === 0x1b /* ESC */) {
      if (this.opts.loneEscDelayMs === 0) {
        this.handleLoneEscapeImmediate();
      } else {
        this.pendingEsc = Buffer.from(buf);
        this.escTimer = setTimeout(() => this.commitPendingEscAsEscape(), this.opts.loneEscDelayMs);
      }
      return;
    }

    this.emit("data", buf);
  }

  private handleLoneEscapeImmediate() {
    if (this.opts.exitOnEsc && !this.passthrough) this.emit("escape");
    else this.emit("data", Buffer.from([0x1b]));
  }

  private commitPendingEscAsEscape() {
    this.escTimer = null;
    if (!this.pendingEsc) return;

    this.pendingEsc = null;
    if (this.opts.exitOnEsc && !this.passthrough) this.emit("escape");
    else this.emit("data", Buffer.from([0x1b]));
  }

  private flushPendingEscAsData() {
    if (this.pendingEsc) {
      this.cancelEscTimer();
      const b = this.pendingEsc;
      this.pendingEsc = null;
      this.emit("data", b);
    }
  }

  private cancelEscTimer() {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }
}



// -------------------- Back-compat for tests --------------------

/**
 * Keep named export but also restore the historical default export so that
 * `import Controller from "src/input/controller"` continues to work.
 * (The file already exports `InputController` as a named symbol.)
 */
// eslint-disable-next-line import/no-default-export
export default InputController;

/**
 * A tiny factory used only by tests. It constructs an InputController with
 * PassThrough streams unless the caller supplies custom streams.
 *
 * This signature is intentionally loose to avoid depending on the exact
 * constructor type of InputController.
 */
export function makeControllerForTests(
  opts: any = {}
): {
  controller: InputController;
  stdin: import("node:stream").PassThrough;
  stdout: import("node:stream").PassThrough;
} {
  const { PassThrough } = require("node:stream") as typeof import("node:stream");

  const stdin = (opts && opts.stdin) || new PassThrough();
  const stdout = (opts && opts.stdout) || new PassThrough();

  // Allow callers to override any other constructor options via `opts`.
  const controller = new InputController({
    ...opts,
    stdin,
    stdout,
  } as any);

  return { controller, stdin, stdout };
}

// Small default singleton (kept for convenience)
export const DefaultInput = new InputController();

export type SchedulerLike = unknown;

// -------------------- Back-compat: askInitialAndSend --------------------
/**
 * Historical method used by app.ts to optionally seed the first user message.
 * - kickoff === false/undefined: do nothing
 * - kickoff === true: interactive; do nothing (user will type)
 * - kickoff is string: immediately send that text through available APIs
 */
//Why tho
(InputController as any).prototype.askInitialAndSend = async function (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  this: any,
  kickoff: unknown
): Promise<void> {
  if (!kickoff || kickoff === true) return;

  const text = String(kickoff);

  // Prefer newer controller APIs if present
  if (typeof this.send === "function") {
    await this.send(text);
    return;
  }
  if (typeof this.sendText === "function") {
    await this.sendText(text);
    return;
  }

  // If a scheduler is attached, try common scheduler APIs
  const s = this.scheduler;
  if (s) {
    if (typeof s.enqueueUserText === "function") {
      await s.enqueueUserText(text);
      return;
    }
    if (typeof s.enqueue === "function") {
      await s.enqueue({ role: "user", content: text });
      return;
    }
    if (typeof s.send === "function") {
      await s.send(text);
      return;
    }
  }

  // Last resort: if our stdin is a writable PassThrough (tests), write to it.
  const w = this.stdin as unknown as { write?: (chunk: string) => unknown };
  if (w && typeof w.write === "function") {
    w.write(text + "\n");
  }
};
