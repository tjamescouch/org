/**
 * Passthrough
 * -----------
 * Non-interactive input controller used when stdin is not a TTY.
 * - Collects *all* of stdin as UTF-8 text (no key handling, no prompts).
 * - On EOF, forwards the payload to the scheduler as a single message.
 * - Then performs a graceful shutdown: stop → drain → (optional) finalizer.
 *
 * This class is intentionally minimal and has no coupling to TTY behaviors.
 */

import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type PTState = "idle" | "reading" | "closed";

export interface SchedulerLike {
  enqueue?(item: { role: "user"; content: string }): void | Promise<void>;
  enqueueUserText?(text: string): void | Promise<void>;
  send?(text: string): void | Promise<void>;
  stop?(): void | Promise<void>;
  drain?(): void | Promise<void>;
}

export interface PassthroughOptions {
  stdin: Readable;
  stdout: Writable;
  scheduler?: SchedulerLike;
  /**
   * Optional callback invoked after stop/drain on graceful EOF.
   */
  finalizer?: () => void | Promise<void>;
}

export class Passthrough {
  public state: PTState = "idle";

  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private scheduler?: SchedulerLike;
  private finalizer?: () => void | Promise<void>;

  private decoder = new StringDecoder("utf8");
  private buf = "";

  private onDataBound = (chunk: Buffer | string) => this.onData(chunk);
  private onEndBound = () => { void this.onEnd(); };
  private onErrorBound = (_err: unknown) => { /* swallow to avoid noisy pipes */ };

  constructor(opts: PassthroughOptions) {
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    this.scheduler = opts.scheduler;
    this.finalizer = opts.finalizer;
  }

  public setScheduler(s: SchedulerLike | undefined) {
    this.scheduler = s;
  }

  /**
   * Begin consuming stdin. Multiple calls are no-ops after first start.
   */
  public start(): void {
    if (this.state !== "idle") return;
    this.state = "reading";

    // Stream bytes; do not interpret escape sequences or line discipline.
    this.stdin.on("data", this.onDataBound);
    this.stdin.once("end", this.onEndBound);
    this.stdin.once("error", this.onErrorBound);
  }

  /**
   * Write program output to stdout.
   */
  public write(chunk: string | Buffer): void {
    if (this.state === "closed") return;
    //this.stdout.write(chunk);
  }

  /**
   * Close and detach listeners. If `graceful` is true, stop/drain/finalize first.
   */
  public async close(graceful = false): Promise<void> {
    if (this.state === "closed") return;

    this.stdin.off("data", this.onDataBound);
    this.stdin.off("end", this.onEndBound);
    this.stdin.off("error", this.onErrorBound);

    if (graceful) {
      try { await this.scheduler?.stop?.(); } catch {}
      try { await this.scheduler?.drain?.(); } catch {}
      try { await this.finalizer?.(); } catch {}
    }

    this.state = "closed";
  }

  public async askUser(fromAgent: string, content: string): Promise<void> { }

  // ——————————————————————————————————————————————————————————
  // Internal handlers
  // ——————————————————————————————————————————————————————————

  private onData(chunk: Buffer | string) {
    // Preserve bytes like ESC sequences; decode incrementally for valid UTF-8.
    if (typeof chunk === "string") {
      this.buf += this.decoder.write(Buffer.from(chunk));
    } else {
      this.buf += this.decoder.write(chunk);
    }
  }

  private async onEnd(): Promise<void> {
    // Flush any pending decoder state (partial multi-byte sequences).
    const tail = this.decoder.end();
    if (tail) this.buf += tail;

    const payload = this.buf;
    this.buf = "";

    // Forward collected input as a single "user" message if any.
    if (payload.length > 0) {
      const s = this.scheduler;
      try {
        if (s?.enqueueUserText) await s.enqueueUserText(payload);
        else if (s?.enqueue) await s.enqueue({ role: "user", content: payload });
        else if (s?.send) await s.send(payload);
      } catch {
        // Ignore delivery errors; we still attempt graceful finalize below.
      }
    }

    await this.close(true);
  }
}

export default Passthrough;
