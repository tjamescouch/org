/**
 * RandomScheduler (minimal, type-safe implementation)
 * ---------------------------------------------------
 * Implements the IScheduler surface. The loop is event-loop friendly (yields
 * when idle) so TTY keypress/line events are never starved.
 *
 * This is intentionally simple and conservative. It maintains a single
 * FIFO queue for user text and dispatches messages round-robin to agents.
 */

import { Logger } from "../logger";
import {
  IScheduler,
  SchedulerAgent,
  SchedulerOptions,
} from "./scheduler";

export default class RandomScheduler implements IScheduler {
  private readonly agents: SchedulerAgent[];
  private readonly maxTools: number;
  private readonly onAskUser: SchedulerOptions["onAskUser"];
  private promptEnabled: boolean;

  private running = false;
  private draining = false;

  private q: string[] = [];
  private rr = 0; // round-robin cursor

  constructor(opts: SchedulerOptions) {
    this.agents = opts.agents;
    this.maxTools = Math.max(0, opts.maxTools ?? 20);
    this.onAskUser = opts.onAskUser;
    this.promptEnabled = !!opts.promptEnabled;
  }

  async enqueueUserText(text: string): Promise<void> {
    this.q.push(String(text ?? ""));
  }

  async start(): Promise<void> {
    this.running = true;

    // If the app allowed prompting first and there is no queued work,
    // request a concrete instruction.
    if (this.promptEnabled && this.q.length === 0) {
      await this.safeAskUser(
        "scheduler",
        "[scheduler]\nAll agents are idle — no queued work and no actionable outputs.\nPlease provide the next *concrete* instruction."
      );
      // Only ask once on entry; user lines go through enqueueUserText.
      this.promptEnabled = false;
    }

    while (this.running) {
      if (this.draining && this.q.length === 0) {
        // Graceful drain complete.
        this.running = false;
        break;
      }

      if (this.q.length === 0 || this.agents.length === 0) {
        await this.sleep(25);
        continue;
      }

      const text = this.q.shift()!;
      const agent = this.pickAgent();

      try {
        const peers = this.agents.map(a => a.id);
        const shouldAbort = () => !this.running || this.draining;

        Logger.info(`User: ${agent.id} start {`);
        Logger.info(`  promptChars: ${text.length},`);
        Logger.info(`  maxTools: ${this.maxTools},`);
        Logger.info(`}`);

        const out = await agent.respond(text, this.maxTools, peers, shouldAbort);

        if (typeof out === "string" && out.trim().length > 0) {
          Logger.info(`${agent.id} ...`);
          Logger.info(out);
          Logger.info(`[${agent.id}] wrote. No tools used.`);
        }
      } catch (e) {
        Logger.error?.(`Agent '${agent.id}' failed:`, (e as any)?.message || e);
      }

      // Yield a tick so the event loop can service stdin/readline.
      await this.sleep(1);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async drain(): Promise<void> {
    this.draining = true;
    // caller will await start() to return
  }

  // ------------------------ internals ------------------------

  private pickAgent(): SchedulerAgent {
    if (this.agents.length === 0) {
      throw new Error("No agents configured");
    }
    const a = this.agents[this.rr % this.agents.length];
    this.rr = (this.rr + 1) % Math.max(1, this.agents.length);
    return a;
  }

  private async safeAskUser(fromAgent: string, content: string): Promise<void> {
    try {
      await this.onAskUser(fromAgent, content);
    } catch (e) {
      Logger.error?.("onAskUser failed, continuing:", (e as any)?.message || e);
    }
  }

  private sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }
}
