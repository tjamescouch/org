// src/scheduler/random-scheduler.ts
// RandomScheduler with external user-prompt bridge.
// - If `readUserLine` is provided, the scheduler DOES NOT create its own readline,
//   and it DOES NOT bind keypress listeners. It awaits the external provider (TTY controller).
// - Keeps `promptEnabled` semantics so the state machine still "waits for user" after @@user.
// - Prints Examples + idle banner ONCE per idle cycle to avoid repetition.
// - Minimal, type-safe surface to satisfy IScheduler usage in app.ts.

import { setTimeout as sleep } from "node:timers/promises";
import { Logger } from "../logger";

export type ReviewMode = "ask" | "auto" | "never";

// Shape used by app.ts when it constructs agents.
export interface AgentShim {
  id: string;
  respond: (prompt: string, budget: number, peers: string[], shouldStop: () => boolean) => Promise<unknown> | unknown;
  guardOnIdle?: (state: unknown) => unknown | null;
  guardCheck?: (route: unknown, content: string, peers: string[]) => unknown | null;
}

export interface RandomSchedulerOptions {
  agents: AgentShim[];
  maxTools: number;
  onAskUser: (fromAgent: string, content: string) => Promise<string | undefined>;
  projectDir: string;
  reviewMode: ReviewMode;
  /** When true, the scheduler is allowed to *wait for input* in idle state. */
  promptEnabled: boolean;

  /**
   * EXTERNAL PROMPT BRIDGE:
   * If provided, the scheduler will NOT render its own 'user:' banner, and will NOT attach
   * readline/keypress listeners. Instead it will await this function for exactly one line.
   */
  readUserLine?: () => Promise<string | undefined>;
}

// Minimal IScheduler shape expected by app.ts/finalizeOnce.
export interface IScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  drain(): Promise<void>;
  enqueueUserText(text: string): Promise<void>;
}

export default class RandomScheduler implements IScheduler {
  private readonly opts: RandomSchedulerOptions;
  private readonly userQueue: string[] = [];
  private running = false;
  private loop?: Promise<void>;
  private printedExamples = false;

  constructor(opts: RandomSchedulerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loop = this.mainLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
  }

  async drain(): Promise<void> {
    // In this simple scheduler, there's no background work once stopped.
    return;
  }

  async enqueueUserText(text: string): Promise<void> {
    if (typeof text === "string" && text.trim().length > 0) {
      this.userQueue.push(text);
      // Reset idle banner so it will show once after processing the new item (if we go idle again)
      this.printedExamples = false;
    }
  }

  // ---------------------------- internal helpers ----------------------------

  private printIdleExamplesOnce(): void {
    if (this.printedExamples) return;
    this.printedExamples = true;

    Logger.info("Examples:");
    Logger.info('- "@user Outline the next milestone and first task."');
    Logger.info('- "@alice" Ask that agent to run a specific command and report back.');
    Logger.info('- "Switch context to <topic> and set a single success criterion."');

    Logger.info("All agents are idle — no queued work and no actionable outputs.");
    Logger.info("Please provide the next *concrete* instruction.");
  }

  private async promptUserOnceViaBridge(): Promise<string | undefined> {
    if (typeof this.opts.readUserLine === "function") {
      // External UI (TTY controller) owns echo + cooked input under raw TTY.
      return await this.opts.readUserLine();
    }

    // Legacy internal prompt (fallback, rarely used).
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    try {
      const answer = await rl.question("user: (scheduler) ");
      return answer;
    } finally {
      rl.close();
    }
  }

  private resetIdleCycle(): void {
    this.printedExamples = false;
  }

  // Simulate "no actionable outputs" when we aren't integrating agents deeply.
  private async processOneUserLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    // If you later want to route to agents, do it here. For now, we keep the UX stable:
    // show that no agent took action and return to idle (same behavior your screenshots show).
    Logger.info("All agents are idle — no queued work and no actionable outputs.");
    Logger.info("Please provide the next *concrete* instruction.");
  }

  // ------------------------------- main loop ---------------------------------

  private async mainLoop(): Promise<void> {
    while (this.running) {
      // 1) Handle queued user messages (from kickoff or interjection)
      const next = this.userQueue.shift();
      if (typeof next === "string") {
        await this.processOneUserLine(next);
        // after work, next iteration will detect idle again
        continue;
      }

      // 2) Idle branch
      if (this.opts.promptEnabled) {
        // Show Examples + instruction ONCE per idle cycle
        this.printIdleExamplesOnce();

        // Block for exactly one user line (via external bridge if provided)
        const line = await this.promptUserOnceViaBridge();

        if (typeof line === "string" && line.trim().length > 0) {
          await this.enqueueUserText(line);
          // we just queued a line; loop will pick it up immediately
          this.resetIdleCycle();
          continue;
        }

        // No input; loop again (bridge should not attach listeners repeatedly)
        await sleep(25);
      } else {
        // Not prompting in idle: do not spam the banner; sleep.
        await sleep(50);
      }
    }
  }
}
