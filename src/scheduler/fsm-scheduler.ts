// src/scheduler/fsm-scheduler.ts
import { shuffle as fisherYatesShuffle } from "../utils/shuffle-array";
import { C, Logger } from "../logger";
import { NoiseFilters } from "./filters";
import { Inbox } from "./inbox";
import { routeWithSideEffects } from "./router";
import { TagSplitter, TagPart } from "../utils/tag-splitter";
import type { GuardDecision } from "../guardrails/guardrail";
import type { ChatMessage } from "../types";
import type { SchedulerOptions, AskUserFn } from "./types";
import { sleep } from "../utils/sleep";
import { Agent, AgentCallbacks } from "../agents/agent";
import { getUserText } from "./fsm-effects";
import { IScheduler } from "./scheduler";

/**
 * Hooks that the TTY/UI can provide.
 */
type Hooks = {
  onStreamStart: () => void;
  onStreamEnd: () => void | Promise<void>;
};

/** Extend options locally to accept the external prompt bridge without changing the global type. */
type SchedulerOptionsWithBridge = Hooks &
  SchedulerOptions & {
    /**
     * If provided, scheduler will not render its own 'You >' banner or readline.
     * Instead it awaits this provider and treats the returned line as user input.
     * This keeps `promptEnabled` semantics (the scheduler still "waits for user"),
     * but routes I/O through the TTY controller to avoid duplicate listeners.
     */
    readUserLine?: () => Promise<string | undefined>;
  };

enum State {
  Init = "Init",
  Idle = "Idle",
  SelectAgent = "SelectAgent",
  RunAgent = "RunAgent",
  Stopped = "Stopped",
}

/**
 * FSMScheduler
 * ------------
 * A drop-in replacement for RandomScheduler that organizes control flow
 * around a small, explicit finite state machine. It keeps public methods
 * and runtime behavior compatible with the existing scheduler, while
 * factoring user-input reads through a single bridge to avoid "double Enter".
 */
export class FSMScheduler implements IScheduler {
  /** If provided, the UI owns stdin; we just await a line here. */
  readUserLine?: () => Promise<string | undefined>;

  // --- Core collaborators & config ---
  private readonly agents: Agent[];
  private readonly maxTools: number;
  private readonly shuffle: <T>(arr: T[]) => T[];
  private readonly filters = new NoiseFilters();
  private readonly inbox = new Inbox();

  // --- Control flags & state ---
  private running = false;
  private paused = false;
  private draining = false;
  private keepAlive: NodeJS.Timeout | null = null;

  private state: State = State.Init;
  private idleTicks = 0;
  private rescheduleNow = false;

  // --- Scheduler book-keeping ---
  private activeAgent: Agent | undefined;
  private respondingAgent: Agent | undefined;
  private mutedUntil = new Map<string, number>();
  private lastUserDMTarget: string | null = null;
  private interjection: string | undefined;

  // --- Behavior toggles ---
  private readonly idlePromptEvery = 3;
  private readonly askUser: AskUserFn;
  private readonly promptEnabled: boolean;
  private readonly idleSleepMs: number;

  // --- UI hooks ---
  private readonly onStreamStart: Hooks["onStreamStart"];
  private readonly onStreamEnd: Hooks["onStreamEnd"];

  constructor(opts: SchedulerOptionsWithBridge) {
    this.onStreamStart = opts.onStreamStart;
    this.onStreamEnd = opts.onStreamEnd;
    this.agents = opts.agents;
    this.maxTools = opts.maxTools;
    this.shuffle = opts.shuffle ?? fisherYatesShuffle;
    this.askUser = opts.onAskUser;

    this.promptEnabled = !!opts.promptEnabled;
    this.idleSleepMs = opts.idleSleepMs ?? 25;

    // External prompt bridge (owned by TTY controller)
    this.readUserLine = opts.readUserLine;

    for (const a of this.agents) this.inbox.ensure(a.id);
  }

  /** Start the scheduler main loop (returns when stopped). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.keepAlive = setInterval(() => {
      /* keep event loop alive during long idle */
    }, 30_000);

    try {
      this.state = State.Init;

      while (this.running) {
        // Cooperative pause/drain handling
        if (this.paused || this.draining) {
          await sleep(25);
          continue;
        }

        switch (this.state) {
          case State.Init: {
            this.activeAgent = undefined;
            this.respondingAgent = undefined;
            this.idleTicks = 0;
            this.state = State.Idle;
            break;
          }

          case State.Idle: {
            // Process a pending user interjection (e.g., programmatic injection)
            if (this.interjection) {
              await this.handleUserInterjection(this.interjection, {
                defaultTargetId: this.lastUserDMTarget ?? undefined,
              });
              this.interjection = undefined;
              this.rescheduleNow = true;
            }

            const ready = this.agents.filter((a) => this.inbox.hasWork(a.id));
            if (ready.length > 0) {
              this.state = State.SelectAgent;
              break;
            }

            // No ready work → idle path (prompt the user periodically)
            this.idleTicks++;
            const queuesEmpty = !this.inbox.hasAnyWork();

            if (
              queuesEmpty &&
              this.promptEnabled &&
              typeof this.readUserLine === "function"
            ) {
              const preferred = this.lastUserDMTarget ?? this.agents[0]?.id ?? undefined;
              const line = ((await this.readUserLine()) ?? "").trim();
              if (line) {
                await this.handleUserInterjection(line, { defaultTargetId: preferred });
                this.idleTicks = 0;
              } else {
                await sleep(this.idleSleepMs);
              }
              break;
            }

            if (queuesEmpty && (this.idleTicks % this.idlePromptEvery) === 0 && this.promptEnabled) {
              const peers = this.agents.map((x) => x.id);
              const dec =
                this.agents[0]?.guardOnIdle?.({
                  idleTicks: this.idleTicks,
                  peers,
                  queuesEmpty: true,
                }) || null;

              const preferred = this.lastUserDMTarget ?? this.agents[0]?.id ?? undefined;
              const prompt =
                (dec as any)?.askUser ??
                `(scheduler)
All agents are idle.
Type a message. Prefix with @@<agentId> to DM (peers: ${peers.join(
                  ", "
                )}). Use @@group for broadcast.`;

              const userText = await getUserText({
                label: "scheduler",
                prompt,
                readUserLine: this.readUserLine,
                askUser: this.askUser,
                log: (msg: string) => Logger.info(msg),
              });

              if (userText) {
                await this.handleUserInterjection(userText, {
                  defaultTargetId: preferred,
                });
                this.idleTicks = 0;
              } else {
                await sleep(this.idleSleepMs);
              }
              break;
            }

            // Cooperative idle
            await sleep(this.idleSleepMs);
            break;
          }

          case State.SelectAgent: {
            // Determine order of agents to try this tick
            const ready = this.agents.filter((a) => this.inbox.hasWork(a.id));
            const order = this.shuffle(ready);

            let advanced = false;
            for (const agent of order) {
              if (this.rescheduleNow) break;

              if (this.isMuted(agent.id)) {
                Logger.debug(`muted: ${agent.id}`);
                continue;
              }

              const next = this.respondingAgent ?? agent;
              this.respondingAgent = undefined;

              const messages = this.inbox.nextPromptFor(next.id);
              if (messages.length === 0) {
                Logger.debug(`no work for ${next.id}`);
                continue;
              }

              this.activeAgent = next;
              const didWork = await this.runAgentOnce(next, messages);
              this.activeAgent = undefined;

              if (didWork) {
                // Work done → next scheduler tick
                advanced = true;
                break;
              }
            }

            if (!advanced) {
              this.state = State.Idle;
            } else {
              // If an agent worked, immediately go back to Idle where
              // we re-check for more ready work or prompt the user.
              this.state = State.Idle;
            }
            break;
          }

          case State.RunAgent: {
            // Not used directly; we run inside SelectAgent loop.
            this.state = State.Idle;
            break;
          }

          case State.Stopped:
          default: {
            this.running = false;
            break;
          }
        }
      }
    } catch (e) {
      Logger.error("Scheduler start failed.", e);
    } finally {
      for (const agent of this.agents) {
        try { agent.save(); } catch { /* ignore */ }
      }

      if (this.keepAlive) {
        clearInterval(this.keepAlive);
        this.keepAlive = null;
      }

      this.running = false;
    }
  }

  stop(): void {
    this.running = false;
    Logger.debug("stopped");
  }

  pause(): void {
    this.paused = true;
    Logger.debug("paused");
  }

  resume(): void {
    this.paused = false;
    Logger.debug("resumed");
  }

  async drain(): Promise<boolean> {
    if (this.draining) return false;
    this.draining = true;
    while (this.hasActiveAgent()) {
      Logger.info(C.magenta(`\nWaiting for agent to complete...`));
      await sleep(1000);
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

  async interject(text: string): Promise<void> {
    this.interjection = text;
  }

  /**
   * Enqueue user text.
   * - Explicit @@agent tags override everything (reschedule immediately)
   * - Else, if provided, DM the default target
   * - Else, broadcast to the group
   */
  private async handleUserInterjection(
    text: string,
    opts?: { defaultTargetId?: string }
  ): Promise<void> {
    const raw = String(text ?? "");
    const parts = TagSplitter.split(raw, {
      userTokens: ["user"],
      groupTokens: ["group"],
      agentTokens: this.agents.map((a) => a.id), // allowlist
      fileTokens: ["file"],
      allowFileShorthand: false,
    });

    // Explicit @@agent tag(s)
    const agentParts = parts.filter(
      (p) => p.kind === "agent"
    ) as Array<TagPart & { kind: "agent" }>;

    Logger.debug("agentParts", agentParts);

    if (agentParts.length > 0) {
      const targets: Agent[] = [];
      for (const ap of agentParts) {
        const ag = this.findAgentByIdExact(ap.tag);
        if (ag && !targets.some((t) => t.id === ag.id)) targets.push(ag);
      }
      if (targets.length > 0) {
        this.respondingAgent = targets[0];
        this.lastUserDMTarget = targets[0].id;
        for (const ap of agentParts) {
          const ag = this.findAgentByIdExact(ap.tag);
          if (!ag) continue;
          const msg: ChatMessage = {
            content: ap.content,
            role: "user",
            from: "User",
          };
          this.inbox.push(ag.id, msg);
          Logger.info(`[user → @@${ag.id}] ${raw}`);
        }
        this.rescheduleNow = true;
        return;
      }
    }

    // DM default target if provided
    if (opts?.defaultTargetId) {
      const ag = this.findAgentByIdExact(opts.defaultTargetId);
      if (ag) {
        const msg: ChatMessage = {
          content: raw.trim(),
          role: "user",
          from: "User",
        };
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
      this.inbox.push(a.id, { content: raw.trim(), role: "user", from: "User" });
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

  private async applyGuardDecision(agent: Agent, dec: GuardDecision) {
    if (dec.warnings && dec.warnings.length) {
      Logger.debug(`[guard][${agent.id}] ` + (dec as any).warnings.join("; "));
    }
    if (dec.nudge) {
      this.inbox.push(agent.id, {
        content: dec.nudge,
        from: "System",
        role: "system",
      });
    }
    if (dec.muteMs && dec.muteMs > 0) {
      this.mute(agent.id, dec.muteMs);
    }
    if (dec.askUser && this.promptEnabled) {
      this.lastUserDMTarget = agent.id; // prefer the nudging agent
      const userText = await getUserText({
        label: agent.id,
        prompt: dec.askUser,
        readUserLine: this.readUserLine,
        askUser: this.askUser,
        log: (msg: string) => Logger.info(msg),
      });
      if (userText) {
        await this.handleUserInterjection(userText, {
          defaultTargetId: agent.id,
        });
      }
    }
  }

  private findAgentByIdExact(key: string): Agent | undefined {
    const t = key.toLowerCase();
    return this.agents.find((a) => a.id.toLowerCase() === t);
  }

  // Run a single agent once with its drained messages, returning whether
  // it produced any output (used to decide if we "did work" this tick).
  private async runAgentOnce(a: Agent, messagesIn: ChatMessage[]): Promise<boolean> {
    let remaining = this.maxTools;
    let totalToolsUsed = 0;
    this.activeAgent = a;

    try {
      const callbacks: AgentCallbacks = {
        onRouteCompleted: async (message, numToolsUsed, askedUser) => {
          if (numToolsUsed > 0) {
            return false; // If the agent just did a tool call, let it continue
          }

          const shouldUserRespond =
            askedUser || this.agents.length === 1 || !this.inbox.hasAnyWork();

          if (!shouldUserRespond) {
            return false;
          }

          this.lastUserDMTarget = a.id;
          const userText = await getUserText({
            label: a.id,
            prompt: message,
            readUserLine: this.readUserLine,
            askUser: this.askUser,
            log: (msg: string) => Logger.info(msg),
          });
          if (userText) {
            await this.handleUserInterjection(userText, {
              defaultTargetId: a.id,
            });
          }
          this.rescheduleNow = true;
          return true;
        },
        shouldAbort: () => this.draining,
        onStreamStart: this.onStreamStart,
        onStreamEnd: this.onStreamEnd,
        onRoute: async (message: string, filters: NoiseFilters) => {
          return await routeWithSideEffects(
            {
              agents: this.agents,
              enqueue: (toId, msg) => this.inbox.push(toId, msg),
              setRespondingAgent: (id) => {
                this.respondingAgent = this.agents.find((x) => x.id === id);
              },
              applyGuard: (_from, dec) => this.applyGuardDecision(a, dec),
              setLastUserDMTarget: (id) => {
                this.lastUserDMTarget = id;
              },
            },
            this,
            message,
            filters
          );
        },
      };

      const peers = this.agents.filter(agent => agent.id !== a.id);
      const result = await a.respond(
        messagesIn,
        Math.max(0, remaining),
        this.filters,
        peers,
        callbacks
      );

      return (Array.isArray(result) ? result.length > 0 : !!result);
    } finally {
      if (totalToolsUsed > 0) {
        // this.review.markDirty(a.id);
      }
    }
  }
}
