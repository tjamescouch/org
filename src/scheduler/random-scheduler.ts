/**
 * RandomScheduler
 * ----------------
 * NOTE: This version adds **event-loop friendly back-off** so the scheduler
 * yields when there is no work. Without this, the while-loop can busy-spin and
 * starve readline/TTY keypress handling, making the prompt appear “dead”.
 */

import { Logger } from "../logger";

/** Minimal Agent shape used by the scheduler loop. */
type Agent = { id: string };

/** Minimal Inbox interface expected by this scheduler. */
interface Inbox {
  haswork(agentId: string): boolean;
}

export class RandomScheduler {
  // --- lifecycle flags ---
  private running = false;
  private paused = false;
  private draining = false;
  private rescheduleNow = false;

  // --- wiring ---
  private agents: Agent[];
  private inbox: Inbox;

  // bookkeeping / policy
  private respondingAgent: Agent | undefined;
  private activeAgent: Agent | undefined;
  private maxTools: number;

  constructor(opts: {
    agents: Agent[];
    inbox: Inbox;
    maxTools?: number;
  }) {
    this.agents = opts.agents;
    this.inbox = opts.inbox;
    this.maxTools = Math.max(0, opts.maxTools ?? 20);
  }

  /** Public API — start the scheduler loop. */
  async start(): Promise<void> {
    this.running = true;
    await this.startBody();
  }

  /** Request the loop to pause (not used in this snippet). */
  pause() { this.paused = true; }
  resume() { this.paused = false; }

  /** Request a graceful drain/stop. */
  async drain() { this.draining = true; }

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

      // Choose agents that currently have messages waiting.
      const ready = this.agents.filter((a) => this.inbox.haswork(a.id));
      const order = this.shuffle(ready);

      Logger.info("2.5 – agents with work:", ready.map(a => a.id));

      // >>>>>>>>>>>> CRITICAL BACK-OFF WHEN IDLE <<<<<<<<<<<<<<
      // If no agent has work, yield briefly so the event loop can run
      // (this avoids starving readline/keypress events).
      if (order.length === 0) {
        await this.sleep(25);
        continue;
      }
      // ------------------------------------------------------

      for (const agent of order) {
        if (this.rescheduleNow) break;

        // (Your actual logic that drains prompts / runs the agent goes here.)
        // Marking that we did some work prevents the secondary back-off below.
        didWork = true;

        // In a real implementation you'd:
        // - drain messages for `agent`
        // - call into the agent/driver
        // - update inbox/state
        // - possibly set `this.rescheduleNow = true` to re-pick agents
      }

      // Secondary back-off: if we iterated but ended up not doing
      // any actual agent work, yield a tiny bit to avoid micro-spins.
      if (!didWork) {
        await this.sleep(10);
      }
    }
  }

  // ------------------------------------------------------------------
  // Utilities / placeholders (keep your original implementations)
  // ------------------------------------------------------------------

  /** Fisher-Yates shuffle (stable enough for our purposes). */
  private shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Promise-based sleep/yield helper. */
  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
