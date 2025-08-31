// src/scheduler/random-scheduler.ts
//
// RandomScheduler — robust, type-safe, and stream-deferral aware.
//   • The runtime owns the TTY controller. We only call its hooks that you inject.
//   • Every chattering section is bracketed with onStreamStart/onStreamEnd.
//   • stop()/drain() semantics ensure we don't hang on finalize.
//
// Structure
//   1) Types
//   2) Small primitives (AsyncQueue, deferral helpers)
//   3) Scheduler
//   4) (optional) Token streaming adapter

import { Logger } from "../logger";

// ───────────────────────────────────────────────────────────────────────────────
// 1) Types
// ───────────────────────────────────────────────────────────────────────────────

export type ReviewMode = "ask" | "auto" | "never";

/**
 * Minimal Agent contract based on your current usage:
 *   respond(prompt, budget, peers, shouldStop) → Promise<RespondOutcome>
 */
export interface Agent {
  id: string;
  respond: (
    prompt: string,
    budget: number,
    peers: string[],
    shouldStop: () => boolean
  ) => Promise<RespondOutcome>;
}

export interface RespondOutcome {
  // Extend as you need; scheduler doesn't rely on details today.
}

export interface StreamHooks {
  onStreamStart: () => void;
  onStreamEnd: () => void | Promise<void>;
}

export interface RandomSchedulerOptions {
  agents: Agent[];
  maxTools: number;

  onAskUser: (fromAgent: string, content: string) => Promise<string | undefined>;

  projectDir: string;
  reviewMode: ReviewMode;

  /** If true, the scheduler may prompt the user when idle (via readUserLine). */
  promptEnabled: boolean;

  /** Render a one-line user prompt (runtime-owned controller). */
  readUserLine: () => Promise<string>;

  /** Injected from the runtime-owned controller (ESC/`i` deferral relies on these). */
  onStreamStart: StreamHooks["onStreamStart"];
  onStreamEnd: StreamHooks["onStreamEnd"];
}

/** Surface that the runtime uses during finalize. */
export interface IScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  drain(): Promise<void>;
  enqueueUserText(text: string): Promise<void>;
  finalizeAndReview(): Promise<{ patchProduced: boolean }>;
}

// ───────────────────────────────────────────────────────────────────────────────
// 2) Small primitives
// ───────────────────────────────────────────────────────────────────────────────

/** Awaitable FIFO queue with close semantics. */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(v: T | undefined) => void> = [];
  private closed = false;

  enqueue(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  /** Resolves to `undefined` when closed and empty. */
  async dequeue(): Promise<T | undefined> {
    if (this.items.length > 0) return this.items.shift();
    if (this.closed) return undefined;
    return await new Promise<T | undefined>((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.(undefined);
  }

  isClosed(): boolean { return this.closed; }
}

/** Run a "chattering" workload so hooks always fire (once at start, once in finally). */
async function withStreamDeferral<T>(
  hooks: StreamHooks,
  work: () => Promise<T>
): Promise<T> {
  hooks.onStreamStart();
  try {
    return await work();
  } finally {
    await hooks.onStreamEnd();
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 3) Scheduler
// ───────────────────────────────────────────────────────────────────────────────

export default class RandomScheduler implements IScheduler {
  private readonly agents: Agent[];
  private readonly opts: RandomSchedulerOptions;

  private readonly inbox = new AsyncQueue<string>();
  private running = false;
  private loopPromise: Promise<void> | null = null;

  // Cancellation & inflight tracking
  private stopRequested = false;
  private inflight = 0;

  // If you later pass an AbortSignal to agents, wire it here.
  // For now we rely on the shouldStop predicate (agents should check it).
  // private currentAbort: AbortController | null = null;

  // Timeouts to keep finalize responsive even with misbehaving agents.
  private static readonly DRAIN_POLL_MS = 20;
  private static readonly DRAIN_MAX_WAIT_MS = 30_000; // 30s hard cap (adjust to taste)

  constructor(opts: RandomSchedulerOptions) {
    this.opts = opts;
    this.agents = opts.agents;
  }

  /** Start the main loop. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.loopPromise = this.loop();
  }

  /** Graceful stop: signal, close inbox, and wait for completion. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.inbox.close();
    // If using an AbortController later, call: this.currentAbort?.abort();
    await this.drain();
    this.running = false;
  }

  /** Wait for loop + inflight to complete (bounded). */
  async drain(): Promise<void> {
    // Wait for the loop to exit (inbox closed or stop requested)
    if (this.loopPromise) {
      try { await this.loopPromise; } catch (err) {
        Logger.warn(`scheduler loop ended with error: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
    // Bounded wait for inflight work to drain
    const until = Date.now() + RandomScheduler.DRAIN_MAX_WAIT_MS;
    while (this.inflight > 0 && Date.now() < until) {
      await new Promise<void>((r) => setTimeout(r, RandomScheduler.DRAIN_POLL_MS));
    }
    if (this.inflight > 0) {
      Logger.warn(`drain(): proceeding with ${this.inflight} task(s) still inflight (timed out)`);
    }
  }

  /** Called by TTY (idle or interjection). */
  async enqueueUserText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.inbox.enqueue(trimmed);
  }

  /**
   * ESC path can call this if you want the scheduler to drive review.
   * Many setups let the runtime finalizer run the pager; here we simply
   * return that a patch exists so the controller proceeds to exit.
   */
  async finalizeAndReview(): Promise<{ patchProduced: boolean }> {
    Logger.info("random-scheduler.finalizeAndReview(): delegate to runtime review manager if needed");
    return { patchProduced: true };
  }

  // ─────────────────────────────── loop plumbing ──────────────────────────────

  private async loop(): Promise<void> {
    try {
      while (!this.stopRequested) {
        const next = await this.nextWork();
        if (next === undefined) break; // queue closed, nothing more to do

        const agent = this.pickAgent();
        const peers = this.agents.filter(a => a.id !== agent.id).map(a => a.id);
        const budget = this.opts.maxTools;

        this.inflight++;
        try {
          await withStreamDeferral(
            { onStreamStart: this.opts.onStreamStart, onStreamEnd: this.opts.onStreamEnd },
            async () => {
              // Agents should check shouldStop periodically (tool loops, long I/O, etc.)
              const shouldStop = (): boolean => this.stopRequested;
              await agent.respond(next, budget, peers, shouldStop);
            }
          );
        } catch (err) {
          Logger.warn(`agent "${agent.id}" failed: ${String(err instanceof Error ? err.message : err)}`);
          // onStreamEnd already fired via withStreamDeferral.finally
        } finally {
          this.inflight--;
        }
      }
    } finally {
      // Ensure the queue is closed; wake any pending readers
      this.inbox.close();
    }
  }

  /**
   * Consume queued work if present; otherwise, prompt (if enabled).
   * Returns `undefined` when the queue is closed and empty (stop requested).
   */
  private async nextWork(): Promise<string | undefined> {
    // 1) Prefer queued work
    const fromQueue = await this.inbox.dequeue();
    if (typeof fromQueue === "string") return fromQueue;
    if (this.stopRequested) return undefined;

    // 2) If prompts are enabled, collect one line via the runtime-controlled TTY
    if (this.opts.promptEnabled) {
      try {
        const line = await this.opts.readUserLine();
        const t = line.trim();
        if (t.length === 0) {
          // Empty: keep looping, but don't starve the queue
          return await this.nextWork();
        }
        return t;
      } catch (err) {
        Logger.warn(`readUserLine() failed: ${String(err instanceof Error ? err.message : err)}`);
        // Fall back to waiting on the queue (or stopping if closed)
        return await this.inbox.dequeue();
      }
    }

    // 3) Otherwise block on the queue (or stop if closed)
    return await this.inbox.dequeue();
  }

  private pickAgent(): Agent {
    if (this.agents.length === 0) {
      throw new Error("RandomScheduler: no agents configured");
    }
    const idx = Math.floor(Math.random() * this.agents.length);
    return this.agents[idx]!;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 4) Optional: token streaming adapter (reference only)
//
// If/when your driver exposes per-token callbacks or an async iterator, replace
// the withStreamDeferral(...) call above with a notifier that fires on the first
// token, then `await hooks.onStreamEnd()` after the stream completes.
//
// function makeTokenNotifier(hooks: StreamHooks) {
//   let started = false;
//   return {
//     onToken(): void {
//       if (!started) {
//         started = true;
//         hooks.onStreamStart();
//       }
//     },
//     async end(): Promise<void> {
//       if (!started) hooks.onStreamStart();
//       await hooks.onStreamEnd();
//     },
//   };
// }
