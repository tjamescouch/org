// src/scheduler/random-scheduler.ts
import { shuffle as fisherYatesShuffle } from "../utils/shuffle-array";
import { C, Logger } from "../logger";
import { NoiseFilters } from "./filters";
import { Inbox } from "./inbox";
import { routeWithSideEffects } from "./router";
import { ReviewManager } from "./review-manager";
import { TagSplitter, TagPart } from "../utils/tag-splitter";
import type { GuardDecision } from "../guardrails/guardrail";
import type { ChatMessage } from "../types";
import type { Responder, SchedulerOptions, AskUserFn } from "./types";
import { sandboxMangers } from "../sandbox/session";
import { sleep } from "../utils/sleep";

/**
 * RandomScheduler
 * ---------------
 * Restores the pre-refactor behavior:
 *  - Uses Inbox for per-agent/group routing
 *  - Respects explicit @@agent DMs, default DM target, and @group broadcast
 *  - Applies guardrail decisions (nudge/mute/askUser)
 *  - Performs multi-hop execution until tool budget exhausted
 *  - Idle prompting via askUser every few idle ticks when enabled
 *  - Draining/pause/resume/stop and review integration
 *
 * Notes:
 *  - Added `enqueueUserText(text)` as a typed alias to the interjection path,
 *    so newer call sites remain compatible without changing the old surface.
 */
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

  // when true, break the current agent loop and start a new tick immediately
  private rescheduleNow = false;

  constructor(opts: SchedulerOptions) {
    this.agents = opts.agents;
    this.maxTools = opts.maxTools;
    this.shuffle = opts.shuffle ?? fisherYatesShuffle;
    this.review = new ReviewManager(opts.projectDir, opts.reviewMode ?? "ask");
    this.askUser = opts.onAskUser;

    this.promptEnabled = !!opts.promptEnabled;
    this.idleSleepMs = opts.idleSleepMs ?? 25;

    for (const a of this.agents) this.inbox.ensure(a.id);
  }



  /** Start the scheduling loop (idempotent). */
  private startBody = async (): Promise<void> => {
    if (this.running) return;
    this.running = true;
    this.keepAlive = setInterval(() => {
      /* keep event loop alive during long idle */
    }, 30_000);

    let idleTicks = 0;

    while (this.running) {
      this.activeAgent = undefined;

      if (this.paused || this.draining) {
        await sleep(25);
        continue;
      }

      let didWork = false;
      this.rescheduleNow = false;

      // Choose agents that currently have messages waiting.
      const ready = this.agents.filter(a => this.inbox.hasWork(a.id));
      const order = this.shuffle(ready);

      for (const agent of order) {
        if (this.rescheduleNow) break;
        if (this.isMuted(agent.id)) {
          Logger.debug(`muted: ${agent.id}`);
          continue;
        }

        const a = this.respondingAgent ?? agent;
        this.respondingAgent = undefined;

        const messages = this.inbox.nextPromptFor(a.id);
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

            const replies = await a.respond(
              messages,
              Math.max(0, remaining),
              peers,
              () => this.draining
            );

            for (const { message, toolsUsed } of replies) {
              totalToolsUsed += toolsUsed;
              this.activeAgent = undefined;
              Logger.debug(
                `${a.id} replied toolsUsed=${toolsUsed} message=`,
                JSON.stringify(message)
              );

              const askedUser = await routeWithSideEffects(
                {
                  agents: this.agents,
                  enqueue: (toId, msg) => this.inbox.push(toId, msg),
                  setRespondingAgent: (id) => {
                    this.respondingAgent = this.agents.find(x => x.id === id);
                  },
                  applyGuard: (from, dec) => this.applyGuardDecision(from, dec),
                  setLastUserDMTarget: (id) => {
                    this.lastUserDMTarget = id;
                  },
                },
                a,
                message,
                this.filters,
              );

              didWork = true;

              if (askedUser) {
                if (this.promptEnabled) {
                  // interactive: open prompt as before
                  this.lastUserDMTarget = a.id;
                  const userText = ((await this.askUser(a.id, message)) ?? "").trim();
                  if (userText) {
                    await this.handleUserInterjection(userText, {
                      defaultTargetId: a.id,
                    });
                  }
                  this.rescheduleNow = true;
                } else {
                  // non-interactive: end the loop; finalization happens in CLI shutdown
                  Logger.info(`(${a.id}) requested @@user; ending run (non-interactive).`);
                  this.stop();
                  this.rescheduleNow = true;
                }
                break;
              }
            }

            if (this.rescheduleNow) break;
            if (totalToolsUsed > 0) {
              remaining = Math.max(0, remaining - totalToolsUsed);
              if (remaining <= 0) break;
            } else {
              break;
            }
          }
        } finally {
          if (totalToolsUsed > 0) this.review.markDirty(agent.id);
        }
      }

      if (!didWork) {
        idleTicks++;
        const queuesEmpty = !this.inbox.hasAnyWork();

        if (queuesEmpty && (idleTicks % this.idlePromptEvery) === 0 && this.promptEnabled) {
          const peers = this.agents.map(x => x.id);
          const dec =
            this.agents[0]?.guardOnIdle?.({ idleTicks, peers, queuesEmpty: true }) || null;
          const prompt =
            (dec as any)?.askUser ??
            `(scheduler)
All agents are idle. Provide the next concrete instruction or question.`;
          const preferred = this.agents[0]?.id;
          if (preferred) this.lastUserDMTarget = preferred;
          const userText = ((await this.askUser("scheduler", prompt)) ?? "").trim();
          if (userText) {
            await this.handleUserInterjection(userText, {
              defaultTargetId: preferred || undefined,
            });
          }
          idleTicks = 0;
        } else {
          await this.sleep(this.idleSleepMs); // cooperative idle
        }
      } else {
        idleTicks = 0;
      }
    }

    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  };

  // ------------------------------ Public API ------------------------------
  async start() {
    try {
      await this.startBody();
    } catch (e) {
      Logger.error("Scheduler start failed.", e);
    } finally {
      if (this.keepAlive) {
        clearInterval(this.keepAlive);
        this.keepAlive = null;
      }

      // Finalize any dirty sessions and run review/apply once.
      // Make ReviewManager.finalizeAndReview() idempotent so double-calls are safe.
      await this.review.finalizeAndReview();
      this.running = false;
    }
  }

  stop() {
    this.running = false;
    Logger.debug("stopped");
  }
  pause() {
    this.paused = true;
    Logger.debug("paused");
  }
  resume() {
    this.paused = false;
    Logger.debug("resumed");
  }

  async drain(): Promise<boolean> {
    if (this.draining) return false;
    this.draining = true;
    while (this.hasActiveAgent()) {
      Logger.info(C.magenta(`\nWaiting for agent to complete...`));
      await this.sleep(1000);
    }
    return true;
  }

  stopDraining(): void {
    this.draining = false;
  }
  isDraining(): boolean {
    return this.draining;
  }
  hasActiveAgent(): boolean {
    return !!this.activeAgent;
  }

  /** External entry for user interjections (e.g., CLI input). */
  async interject(text: string) {
    await this.handleUserInterjection(text, {
      defaultTargetId: this.lastUserDMTarget || undefined,
    });
  }

  /** Alias for compatibility with newer callers; routes to interject(). */
  async enqueueUserText(text: string): Promise<void> {
    await this.interject(text);
  }

  async finalizeAndReviewAll(): Promise<void> {
    try {
      await this.review.finalizeAndReview(this.agents.map(a => a.id));
    } catch (e: any) {
      Logger.error("finalizeAndReviewAll:", e?.message ?? e);
    }
  }

  /**
   * Enqueue user text.
   * - Explicit agent tags override everything (we reschedule immediately).
   * - Otherwise DM the default target, else broadcast to group.
   */
  private async handleUserInterjection(
    text: string,
    opts?: { defaultTargetId?: string }
  ) {
    const raw = String(text ?? "");
    const parts = TagSplitter.split(raw, {
      allowSingleAt: true,
      allowSingleHash: false,
      userTokens: ["user"],
      groupTokens: ["group"],
      agentTokens: this.agents.map(a => a.id), // allowlist
      fileTokens: ["file"],
      allowFileShorthand: false,
    });

    // Explicit @@agent tags
    const agentParts = parts.filter(p => p.kind === "agent") as Array<
      TagPart & { kind: "agent" }
    >;
    if (agentParts.length > 0) {
      const targets: Responder[] = [];
      for (const ap of agentParts) {
        const ag = this.findAgentByIdExact(ap.tag);
        if (ag && !targets.some(t => t.id === ag.id)) targets.push(ag);
      }
      if (targets.length > 0) {
        this.respondingAgent = targets[0];
        this.lastUserDMTarget = targets[0].id;
        for (const ap of agentParts) {
          const ag = this.findAgentByIdExact(ap.tag);
          if (!ag) continue;
          const msg: ChatMessage = { content: ap.content, role: "user", from: "User" };
          this.inbox.push(ag.id, msg);
          Logger.info(`[user → @@${ag.id}] ${raw}`);
        }
        this.rescheduleNow = true;
        return;
      }
    }

    // No explicit tags -> DM default if provided
    if (opts?.defaultTargetId) {
      const ag = this.findAgentByIdExact(opts.defaultTargetId);
      if (ag) {
        const msg: ChatMessage = { content: raw.trim(), role: "user", from: "User" };
        this.respondingAgent = ag;
        this.lastUserDMTarget = ag.id;
        this.inbox.push(ag.id, msg);
        Logger.info(`[user → @@${ag.id}] ${raw}`);
        this.rescheduleNow = true;
        return;
      }
    }

    // Fallback: broadcast to group
    for (const a of this.agents) {
      this.inbox.push(a.id, { content: raw, role: "user", from: "User" });
    }

    Logger.debug("End of interjection");
    Logger.info(`[user → @@group] ${raw}`);
  }

  // ------------------------------ Internals ------------------------------

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
      this.inbox.push(agent.id, {
        content: (dec as any).nudge,
        from: "System",
        role: "system",
      });
    }
    if ((dec as any).muteMs && (dec as any).muteMs > 0) {
      this.mute(agent.id, (dec as any).muteMs);
    }
    if ((dec as any).askUser && this.promptEnabled) {
      this.lastUserDMTarget = agent.id; // prefer the nudging agent
      const userText = ((await this.askUser(agent.id, (dec as any).askUser)) ?? "").trim();
      if (userText) {
        await this.handleUserInterjection(userText, { defaultTargetId: agent.id });
      }
    }
  }

  /** Exact id match, case-insensitive. */
  private findAgentByIdExact(key: string): Responder | undefined {
    const t = key.toLowerCase();
    return this.agents.find(a => a.id.toLowerCase() === t);
  }

  private sleep(ms: number) {
    return new Promise<void>(r => setTimeout(r, ms));
  }
}

export default RandomScheduler;