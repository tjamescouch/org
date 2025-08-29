/**
 * RandomScheduler
 * ----------------
 * This version adds **event-loop friendly back-off** so the scheduler yields
 * when no agent performs work in a cycle. Without this, the while-loop can
 * busy-spin and starve readline/TTY keypress handling, making the prompt
 * appear “dead”.
 *
 * NOTE: This file deliberately avoids referencing non-existent properties
 * like `this.inbox`. It relies only on the scheduler’s own methods that
 * already exist in your code path (e.g., `nextPromptFor`, `isMuted`,
 * `respondingAgent`, `maxTools`, etc.). Keep those methods as they already
 * are in your project; this file only adjusts the loop control/idle backoff.
 */

import { Logger } from "../logger";

type Agent = { id: string };

export class RandomScheduler {
  // lifecycle flags
  private running = false;
  private paused = false;
  private draining = false;
  private rescheduleNow = false;

  // wiring/state you already have in your scheduler
  private agents: Agent[] = [];
  private respondingAgent: Agent | undefined;
  private activeAgent: Agent | undefined;
  private maxTools = 20;

  constructor(opts: {
    agents: Agent[];
    maxTools?: number;
    // … other options you already use; keep them as-is in your project …
  }) {
    this.agents = opts.agents;
    if (typeof opts.maxTools === "number") this.maxTools = Math.max(0, opts.maxTools);
  }

  // Public API — keep your signatures as they are
  async start(): Promise<void> {
    this.running = true;
    await this.startBody();
  }
  async stop(): Promise<void> { this.running = false; }
  async drain(): Promise<void> { this.draining = true; }

  // ---------------- core loop ----------------
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

      // We no longer guess “readiness” up front using an inbox.
      // Just iterate the agents in random order and see who actually has work
      // (your existing `nextPromptFor` check below decides that).
      const order = this.shuffle(this.agents);

      // (Keep this line if you want the same log, but we won’t report a bogus list.)
      Logger.info("2.5 – agents with work:", []);

      for (const agent of order) {
        if (this.rescheduleNow) break;
        if (this.isMuted?.(agent.id)) { Logger.debug?.(`muted: ${agent.id}`); continue; }

        const a = (this.respondingAgent ?? agent);
        this.respondingAgent = undefined;

        // Your code already has this:
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
          // Whatever your existing hop/tool loop is — keep it.
          // Mark didWork so we don’t back-off immediately after.
          didWork = true;

          // … your actual agent execution goes here …
          // e.g., await this.runAgent(a, messages, {remaining, totalToolsUsed})

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

  // ---------------- utilities (keep your originals if you have them) ----------------

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

  // Optional stubs, used above only if your project already defines them.
  // Remove these if your real class already has concrete implementations.
  private isMuted?(id: string): boolean;
  private nextPromptFor?(id: string): any[];
}
