// src/scheduler/random-scheduler.ts
import { shuffle as fisherYatesShuffle } from "../utils/shuffle-array";
import { C, Logger } from "../logger";
import { NoiseFilters } from "./filters";
import { Inbox } from "./inbox";
import { routeWithSideEffects } from "./router";
import { ReviewManager } from "./review-manager";
import type { GuardDecision } from "../guardrails/guardrail";
import type { ChatMessage } from "../types";
import type { Responder, SchedulerOptions, AskUserFn } from "./types";

export class RandomScheduler {
  private readonly agents: Responder[];
  private readonly maxTools: number;
  private readonly shuffle: <T>(arr: T[]) => T[];
  private readonly review: ReviewManager;
  private readonly filters = new NoiseFilters();
  private readonly inbox = new Inbox();

  private running = false;
  private paused = false;
  private draining = false;

  private activeAgent: Responder | undefined;
  private respondingAgent: Responder | undefined;

  private keepAlive: NodeJS.Timeout | null = null;

  private mutedUntil = new Map<string, number>();
  private lastUserDMTarget: string | null = null;

  private readonly idlePromptEvery = 3;

  private readonly askUser: AskUserFn;
  private readonly promptEnabled: boolean;
  private readonly idleSleepMs: number;

  constructor(opts: SchedulerOptions) {
    this.agents = opts.agents;
    this.maxTools = opts.maxTools;
    this.shuffle = opts.shuffle ?? fisherYatesShuffle;
    this.review = new ReviewManager(opts.projectDir, opts.reviewMode);
    this.askUser = opts.onAskUser;

    this.promptEnabled = !!opts.promptEnabled;
    this.idleSleepMs = opts.idleSleepMs ?? 25;

    for (const a of this.agents) this.inbox.ensure(a.id);
  }

  /** Start the scheduling loop (idempotent). */
  start = async (): Promise<void> => {
    if (this.running) return;
    this.running = true;
    this.keepAlive = setInterval(() => { /* keep event loop alive during idle */ }, 30_000);

    let idleTicks = 0;

    while (this.running) {
      this.activeAgent = undefined;

      if (this.paused || this.draining) {
        await this.sleep(25);
        continue;
      }

      let didWork = false;

      // Choose agents that currently have messages waiting.
      const ready = this.agents.filter(a => this.inbox.hasWork(a.id));
      const order = this.shuffle(ready);

      for (const agent of order) {
        if (this.isMuted(agent.id)) { Logger.debug(`muted: ${agent.id}`); continue; }

        const a = this.respondingAgent ?? agent;
        this.respondingAgent = undefined;

        const messages = this.nextPromptFor(a.id);
        if (messages.length === 0) {
          Logger.debug(`no work for ${a.id}`);
          continue;
        }
        Logger.debug(`drained prompt for ${a.id}:`, JSON.stringify(messages));

        let remaining = this.maxTools;
        let totalToolsUsed = 0;

        try {
          for (let hop = 0; hop < Math.max(1, remaining + 1); hop++) {
            const peers = this.agents.map(x => x.id);
            Logger.debug(`ask ${a.id} (hop ${hop}) with budget=${remaining}`);
            this.activeAgent = a;

            const replies = await a.respond(messages, Math.max(0, remaining), peers, () => this.draining);

            for (const { message, toolsUsed } of replies) {
              totalToolsUsed += toolsUsed;
              this.activeAgent = undefined;
              Logger.debug(`${a.id} replied toolsUsed=${toolsUsed} message=`, JSON.stringify(message));

              const askedUser = await routeWithSideEffects(
                {
                  agents: this.agents,
                  enqueue: (toId, msg) => this.inbox.push(toId, msg),
                  setRespondingAgent: (id) => { this.respondingAgent = this.agents.find(x => x.id === id); },
                  applyGuard: (from, dec) => this.applyGuardDecision(from, dec),
                  setLastUserDMTarget: (id) => { this.lastUserDMTarget = id; },
                },
                a,
                message,
                this.filters
              );

              didWork = true;

              if (askedUser) {
                if (this.promptEnabled) {
                  const userText = ((await this.askUser(a.id, message)) ?? "").trim();
                  if (userText) this.handleUserInterjection(userText);
                } else {
                  Logger.info(`(${a.id}) requested @@user input, but prompt is disabled. Skipping.`);
                }
                break;
              }
            }

            if (totalToolsUsed > 0) {
              remaining = Math.max(0, remaining - totalToolsUsed);
              if (remaining <= 0) break;
            } else {
              break;
            }
          }
        } finally {
          if (totalToolsUsed > 0) {
            await this.review.afterToolBatch(agent.id);
          }
        }
      }

      if (!didWork) {
        idleTicks++;
        const queuesEmpty = this.inbox.allEmpty(this.agents.map(a => a.id));

        if (queuesEmpty && (idleTicks % this.idlePromptEvery) === 0 && this.promptEnabled) {
          const peers = this.agents.map(x => x.id);
          const dec = this.agents[0]?.guardOnIdle?.({ idleTicks, peers, queuesEmpty: true }) || null;
          const prompt =
            dec?.askUser
              ?? `(scheduler)
All agents are idle (and tool budget is exhausted or no work). Please provide the next concrete instruction or question.`;
          const userText = ((await this.askUser("scheduler", prompt)) ?? "").trim();
          if (userText) {
            this.respondingAgent = this.agents[0];
            this.handleUserInterjection(userText);
            idleTicks = 0;
          }
        } else {
          // Cooperative yield when idle to prevent CPU spin and allow signals (Ctrl‑C) to be handled.
          await this.sleep(this.idleSleepMs);
        }
      } else {
        idleTicks = 0;
      }
    }

    if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
  };

  // ------------------------------ Public API ------------------------------

  stop() { this.running = false; Logger.debug("stopped"); }
  pause() { this.paused = true; Logger.debug("paused"); }
  resume() { this.paused = false; Logger.debug("resumed"); }

  async drain(): Promise<boolean> {
    if (this.draining) return false;
    this.draining = true;
    while (this.hasActiveAgent()) {
      Logger.info(C.magenta(`Waiting for agent to complete...`));
      await this.sleep(1000);
    }
    return true;
  }

  stopDraining(): void { this.draining = false; }
  isDraining(): boolean { return this.draining; }
  hasActiveAgent(): boolean { return !!this.activeAgent; }

  /**
   * Enqueue user text.
   * Semantics:
   *  - If one or more @@agent tags appear anywhere, DM ONLY those agent(s)
   *    with the tags stripped from the content. Prefer the first mentioned
   *    agent as the immediate responder.
   *  - Otherwise, broadcast to @@group.
   */
  handleUserInterjection(text: string) {
    const raw = String(text ?? "");
    const tagRe = /@@([a-z][\w-]*)\b/gi;

    const found: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(raw)) !== null) {
      found.push(m[1]);
    }

    const uniqueTargets = Array.from(new Set(found.map(s => s.toLowerCase())));
    const knownTargets: Responder[] = uniqueTargets
      .map(t => this.findAgentById(t))
      .filter((a): a is Responder => !!a);

    if (knownTargets.length > 0) {
      // Strip all tags for delivery.
      const content = raw.replace(tagRe, "").trim();
      const msg: ChatMessage = { content, role: "user", from: "User" };

      // Prefer the first mentioned agent to respond next.
      this.respondingAgent = knownTargets[0];
      this.lastUserDMTarget = knownTargets[0].id;

      for (const a of knownTargets) {
        this.inbox.push(a.id, msg);
        Logger.info(`[user → @@${a.id}] ${raw}`);
      }
      return;
    }

    // No agent tags -> group broadcast.
    for (const a of this.agents) {
      this.inbox.push(a.id, { content: raw, role: "user", from: "User" });
    }
    Logger.info(`[user → @@group] ${raw}`);
  }

  // ------------------------------ Internals ------------------------------

  private nextPromptFor(id: string): ChatMessage[] {
    return this.inbox.drain(id);
  }

  private isMuted(id: string): boolean {
    const until = this.mutedUntil.get(id) ?? 0;
    return Date.now() < until;
  }

  private mute(id: string, ms: number) {
    this.mutedUntil.set(id, Date.now() + Math.max(250, ms));
  }

  private async applyGuardDecision(agent: Responder, dec: GuardDecision) {
    if ((dec as any).warnings && (dec as any).warnings.length) {
      Logger.debug(`[guard][${agent.id}] ` + (dec as any).warnings.join("; "));
    }
    if ((dec as any).nudge) {
      this.inbox.push(agent.id, { content: (dec as any).nudge, from: "System", role: "system" });
    }
    if ((dec as any).muteMs && (dec as any).muteMs > 0) {
      this.mute(agent.id, (dec as any).muteMs);
    }
    if ((dec as any).askUser && this.promptEnabled) {
      const userText = ((await this.askUser(agent.id, (dec as any).askUser)) ?? "").trim();
      if (userText) this.handleUserInterjection(userText);
    }
  }

  private findAgentById(idOrTag: string): Responder | undefined {
    const target = idOrTag.toLowerCase();
    return this.agents.find(a => a.id.toLowerCase() === target);
  }

  private sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
}
