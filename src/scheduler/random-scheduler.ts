// src/scheduler/random-scheduler.ts
//
// Production-ready, type-safe scheduler that keeps your current runtime design:
// - The RUNTIME owns the single TTY controller instance.
// - The SCHEDULER only calls the two hooks you inject: onStreamStart / onStreamEnd.
// - ESC/I deferral "just works" because these hooks bracket every chattering section.
//
// This file is self-contained and split into clear sections:
//   1) Types (no `as any` casts; narrow, explicit contracts)
//   2) Small primitives (AsyncQueue, stream-deferral helpers)
//   3) RandomScheduler implementation (single owner, sequential plan)
//   4) Optional: thin adapter points you can extend later
//
// Notes
// -----
// • The whole LLM call is treated as the “streaming window”. If/when you expose
//   per-token callbacks, switch to the makeTokenNotifier() variant below.
// • Immediate visual feedback and patch review UI are handled by the controller +
//   runtime; the scheduler just ensures hooks are fired exactly once per stream.
// • `finalizeAndReview()` is provided so your TTY controller (or runtime finalizer)
//   can call into the scheduler if desired; return value matches the controller’s
//   expectations.

import { Logger } from "../logger";

// ───────────────────────────────────────────────────────────────────────────────
// 1) Types
// ───────────────────────────────────────────────────────────────────────────────

export type ReviewMode = "ask" | "auto" | "never";

/**
 * Contract your Agents already satisfy based on your existing usage:
 *   respond(prompt, budget, peers, shouldStop)
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

/** You can enrich this later if you want the scheduler to inspect outcomes. */
export interface RespondOutcome {
  // opaque for now
}

export interface StreamHooks {
  onStreamStart: () => void;
  onStreamEnd: () => void | Promise<void>;
}

export interface RandomSchedulerOptions {
  agents: Agent[];
  maxTools: number;

  /** Ask the human for input on behalf of an agent (used by agents/tooling). */
  onAskUser: (fromAgent: string, content: string) => Promise<string | undefined>;

  projectDir: string;
  reviewMode: ReviewMode;

  /**
   * If true, the scheduler may present an idle prompt by calling `readUserLine()`
   * when no work is queued. If false, it waits for `enqueueUserText(...)`.
   */
  promptEnabled: boolean;

  /**
   * The runtime-owned controller renders the prompt; the scheduler just calls this.
   * We keep only one stdin owner: the controller.
   */
  readUserLine: () => Promise<string>;

  /** **Injected from the runtime-owned controller** */
  onStreamStart: StreamHooks["onStreamStart"];
  onStreamEnd: StreamHooks["onStreamEnd"];
}

/**
 * Minimal public surface used by the runtime’s finalizer flow.
 * Your runtime calls `drain()` and `stop()` before patch review.
 */
export interface ISchedulerLite {
  start(): Promise<void>;
  stop(): Promise<void>;
  drain(): Promise<void>;
  enqueueUserText(text: string): Promise<void>;
  finalizeAndReview(): Promise<{ patchProduced: boolean }>;
}

// ───────────────────────────────────────────────────────────────────────────────
// 2) Small primitives
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Awaitable FIFO queue with proper close semantics.
 * Used to sequence user-entered prompts (idle loop + interjections).
 */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(v: T | undefined) => void> = [];
  private closed = false;

  enqueue(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
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
    // wake everyone
    while (this.waiters.length > 0) this.waiters.shift()?.(undefined);
  }

  isClosed(): boolean { return this.closed; }
  isEmpty(): boolean { return this.items.length === 0; }
}

/**
 * Guarantees `onStreamStart()` fires once and `onStreamEnd()` always runs (even on error).
 * Use around any "model is chattering" region.
 */
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

/**
 * Variant for token-by-token streaming. Call `.onToken()` for each token to
 * lazily mark stream start on the first token; call `.end()` once when done.
 */
function makeTokenNotifier(hooks: StreamHooks) {
  let started = false;
  return {
    onToken(): void {
      if (!started) {
        started = true;
        hooks.onStreamStart();
      }
    },
    async end(): Promise<void> {
      if (!started) {
        // No tokens arrived; treat as a very short stream and still provide the hooks.
        hooks.onStreamStart();
      }
      await hooks.onStreamEnd();
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// 3) RandomScheduler implementation
// ───────────────────────────────────────────────────────────────────────────────

export default class RandomScheduler implements ISchedulerLite {
  private readonly agents: Agent[];
  private readonly opts: RandomSchedulerOptions;

  private readonly inbox = new AsyncQueue<string>();
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private inflight = 0;
  private stopRequested = false;

  constructor(opts: RandomSchedulerOptions) {
    this.opts = opts;
    this.agents = opts.agents;
  }

  /**
   * Start the main loop. If `promptEnabled` is true and no work is queued,
   * the scheduler will call `readUserLine()` to collect input.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.loopPromise = this.loop();
  }

  /** Request a graceful stop and wait for the loop to exit. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.inbox.close();
    await this.drain();
    this.running = false;
  }

  /** Wait for the main loop and any inflight agent call to complete. */
  async drain(): Promise<void> {
    // wait for inflight work + loop
    await this.loopPromise;
    while (this.inflight > 0) {
      // micro-yield
      await new Promise<void>((r) => setTimeout(r, 10));
    }
  }

  /** Called by TTY on idle or interjection; adds a unit of work. */
  async enqueueUserText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.inbox.enqueue(trimmed);
  }

  /**
   * ESC path may call this if your controller is wired to ask the scheduler
   * to finalize. In many setups, the runtime finalizer handles patch review,
   * so this method can be a thin delegator. We return a shape the controller expects.
   */
  async finalizeAndReview(): Promise<{ patchProduced: boolean }> {
    Logger.info("random-scheduler.finalizeAndReview(): no-op implementation; runtime finalizer should run the real review");
    // If your runtime finalizer calls into a ReviewManager, you can return
    // its result instead. Returning `true` tells the controller to proceed to exit.
    return { patchProduced: true };
  }

  // ─────────────────────────────── Loop & plumbing ───────────────────────────

  private async loop(): Promise<void> {
    try {
      while (!this.stopRequested) {
        // 1) Get next unit of user work, or collect one if promptEnabled.
        const next = await this.nextWork();
        if (next === undefined) {
          // Queue closed AND empty → stop requested or stdin detached.
          break;
        }

        // 2) Dispatch to a random agent under stream deferral.
        const agent = this.pickAgent();
        const peers = this.agents.filter(a => a.id !== agent.id).map(a => a.id);
        const budget = this.opts.maxTools;

        this.inflight++;
        try {
          await withStreamDeferral(
            { onStreamStart: this.opts.onStreamStart, onStreamEnd: this.opts.onStreamEnd },
            async () => {
              await agent.respond(next, budget, peers, () => this.stopRequested);
            }
          );
        } catch (err) {
          Logger.warn(`Agent "${agent.id}" failed: ${String(err instanceof Error ? err.message : err)}`);
          // Still considered end-of-stream because withStreamDeferral's finally fired above.
        } finally {
          this.inflight--;
        }
      }
    } finally {
      // Ensure the queue is closed (idempotent)
      this.inbox.close();
    }
  }

  /**
   * If there is queued work, consume it; otherwise, if promptEnabled, ask the user.
   * Returns `undefined` when the queue is closed and empty (stop requested).
   */
  private async nextWork(): Promise<string | undefined> {
    // Prefer queued items first
    const pending = await this.inbox.dequeue();
    if (typeof pending === "string") return pending;

    if (this.stopRequested) return undefined;

    if (this.opts.promptEnabled) {
      // Ask the user for a line (controller renders the prompt)
      try {
        const line = await this.opts.readUserLine();
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          // Keep looping; we’re still running and the queue is empty.
          return await this.nextWork();
        }
        return trimmed;
      } catch (err) {
        Logger.warn(`readUserLine() failed: ${String(err instanceof Error ? err.message : err)}`);
        // fall back to idle wait; if stdin is gone, stop soon
        return await this.inbox.dequeue();
      }
    }

    // No prompt; block until something arrives or the queue closes.
    return await this.inbox.dequeue();
  }

  private pickAgent(): Agent {
    if (this.agents.length === 0) {
      throw new Error("RandomScheduler: no agents configured");
    }
    const idx = Math.floor(Math.random() * this.agents.length);
    return this.agents[idx]!;
  }

  // ─────────────────────────────── Optional helpers ──────────────────────────

  /**
   * Example: if you switch to a token-streaming agent API later, replace the
   * `withStreamDeferral()` call with the notifier pattern below.
   *
   * Kept here as a reference (not used by default):
   */
  // private async respondWithTokenStreaming(agent: Agent, prompt: string, peers: string[], budget: number): Promise<void> {
  //   const notify = makeTokenNotifier({ onStreamStart: this.opts.onStreamStart, onStreamEnd: this.opts.onStreamEnd });
  //   if (!agent.stream) {
  //     // Fallback to whole-call deferral if streaming isn't available on this agent.
  //     await withStreamDeferral({ onStreamStart: this.opts.onStreamStart, onStreamEnd: this.opts.onStreamEnd }, async () => {
  //       await agent.respond(prompt, budget, peers, () => this.stopRequested);
  //     });
  //     return;
  //   }
  //   try {
  //     await agent.stream(prompt, {
  //       onToken: (_t) => {
  //         notify.onToken();
  //         // Your runtime’s output mux will handle showing tokens; the controller
  //         // can pause/resume around keypress feedback as needed.
  //       },
  //     });
  //   } finally {
  //     await notify.end();
  //   }
  // }
}
