/**
 * RandomScheduler (event-loop friendly)
 * ------------------------------------
 * This version avoids busy-spinning when no work is available, so the event
 * loop can process TTY keypress/line events (fixes “typing does nothing”).
 *
 * It **does not** assume internal properties like `this.inbox`. Instead:
 * - we iterate agents in a randomized order
 * - we ask the existing method (if present) `nextPromptFor(id)` whether
 *   that agent has messages
 * - if a full cycle does *no* work, we yield briefly (sleep 25 ms)
 *
 * Keep your existing agent execution logic; this file only adjusts loop control.
 */

import { Logger } from "../logger";

type Agent = { id: string };

export class RandomScheduler {
  private running = false;
  private paused = false;
  private draining = false;
  private rescheduleNow = false;

  private agents: Agent[] = [];
  private respondingAgent: Agent | undefined;
  private activeAgent: Agent | undefined;
  private maxTools = 20;

  // Optional hooks expected by your existing implementation
  private isMuted?(id: string): boolean;
  private nextPromptFor?(id: string): any[];
  private runAgent?(
    agent: Agent,
    messages: any[],
    budget: { remaining: number; totalToolsUsed: number }
  ): Promise<void>;

  constructor(opts: {
    agents: Agent[];
    maxTools?: number;
    // any other fields your real scheduler needs can still be passed via opts
  }) {
    this.agents = opts.agents;
    if (typeof opts.maxTools === "number") this.maxTools = Math.max(0, opts.maxTools);
    Object.assign(this, opts); // preserve additional fields/hooks
  }

  async start(): Promise<void> {
    this.running = true;
    await this.startBody();
  }

  async stop(): Promise<void> { this.running = false; }
  async drain(): Promise<void> { this.draining = true; }

  // ------------------------------------------------------------------
  // Core loop
  // ------------------------------------------------------------------
  private async startBody(): Promise<void> {
    while (this.running) {
      this.activeAgent = undefined;
      Logger.info("1");

      if (this.paused || this.draining) {
        await this.sleep(25);
        continue;
      }

      Logger.info("2");

      let didWork = false;
      this.rescheduleNow = false;

      const order = this.shuffle(this.agents);

      // (We keep the same log label for continuity.)
      Logger.info("2.5 – agents with work:", []);

      for (const agent of order) {
        if (this.rescheduleNow) break;
        if (this.isMuted?.(agent.id)) { Logger.debug?.(`muted: ${agent.id}`); continue; }

        const a = (this.respondingAgent ?? agent);
        this.respondingAgent = undefined;

        // Ask your existing method if this agent has any messages.
        const messages = this.nextPromptFor?.(a.id) ?? [];
        if (messages.length === 0) {
          Logger.debug?.(`no work for ${a.id}`);
          continue;
        }

        Logger.debug?.(`drained prompt for ${a.id}:`, JSON.stringify(messages));
        Logger.info("4");

        let remaining = this.maxTools;
        let totalToolsUsed = 0;

        try {
          didWork = true;
          if (this.runAgent) {
            await this.runAgent(a, messages, { remaining, totalToolsUsed });
          } else {
            // Minimal no-op “work” placeholder; replace with your real code.
            await this.sleep(1);
          }
        } catch (e) {
          Logger.error?.("agent run error:", (e as any)?.message || e);
        }
      }

      // >>>>>>>>>>>> CRITICAL BACK-OFF WHEN IDLE <<<<<<<<<<<<<<
      // If the cycle didn’t do any work, yield so the event loop can process
      // readline/keypress events (otherwise typing appears “dead”).
      if (!didWork) {
        await this.sleep(25);
      }
    }
  }

  // ------------------------------------------------------------------
  // Utilities (keep your originals if you have them)
  // ------------------------------------------------------------------

  private shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
