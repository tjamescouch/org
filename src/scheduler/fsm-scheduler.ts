// fsm-scheduler.ts - Drop-in replacement for RandomScheduler
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

type Hooks = {
  onStreamStart: () => void;
  onStreamEnd: () => void | Promise<void>;
};

type SchedulerOptionsWithBridge = Hooks &
  SchedulerOptions & {
    readUserLine?: () => Promise<string | undefined>;
  };

enum SchedulerState {
  STOPPED = "stopped",
  IDLE = "idle", 
  SELECTING_AGENT = "selecting_agent",
  AGENT_RESPONDING = "agent_responding",
  WAITING_USER_INPUT = "waiting_user_input",
  PROCESSING_INTERJECTION = "processing_interjection",
  PAUSED = "paused",
  DRAINING = "draining"
}

enum SchedulerEvent {
  START = "start",
  STOP = "stop",
  PAUSE = "pause", 
  RESUME = "resume",
  BEGIN_DRAIN = "begin_drain",
  STOP_DRAIN = "stop_drain",
  WORK_AVAILABLE = "work_available",
  NO_WORK_AVAILABLE = "no_work_available", 
  AGENT_SELECTED = "agent_selected",
  AGENT_COMPLETED = "agent_completed",
  AGENT_NEEDS_USER = "agent_needs_user",
  USER_INPUT_RECEIVED = "user_input_received",
  INTERJECTION_RECEIVED = "interjection_received",
  INTERJECTION_PROCESSED = "interjection_processed",
  IDLE_TIMEOUT = "idle_timeout"
}

interface StateTransition {
  from: SchedulerState;
  event: SchedulerEvent;
  to: SchedulerState;
  guard?: () => boolean;
  action?: () => Promise<void> | void;
}

export class FSMScheduler {
  private currentState: SchedulerState = SchedulerState.STOPPED;
  
  // Preserve original RandomScheduler fields
  readUserLine?: () => Promise<string | undefined>;
  private readonly agents: Agent[];
  private readonly maxTools: number;
  private readonly shuffle: <T>(arr: T[]) => T[];
  private readonly filters = new NoiseFilters();
  private readonly inbox = new Inbox();

  private running = false;
  private paused = false;
  private draining = false;

  private activeAgent: Agent | undefined;
  private respondingAgent: Agent | undefined;

  private keepAlive: NodeJS.Timeout | null = null;

  private mutedUntil = new Map<string, number>();
  private lastUserDMTarget: string | null = null;

  private readonly idlePromptEvery = 3;

  private readonly askUser: AskUserFn;
  private readonly promptEnabled: boolean;
  private readonly idleSleepMs: number;

  private readonly onStreamStart: Hooks["onStreamStart"];
  private readonly onStreamEnd: Hooks["onStreamEnd"];

  private interjection: string | undefined = undefined;
  private rescheduleNow = false;
  private idleTicks = 0;

  // FSM state machine
  private transitions: StateTransition[] = [
    // Starting/stopping
    { from: SchedulerState.STOPPED, event: SchedulerEvent.START, to: SchedulerState.IDLE, action: () => this.onStart() },
    { from: SchedulerState.IDLE, event: SchedulerEvent.STOP, to: SchedulerState.STOPPED, action: () => this.onStop() },
    { from: SchedulerState.SELECTING_AGENT, event: SchedulerEvent.STOP, to: SchedulerState.STOPPED, action: () => this.onStop() },
    { from: SchedulerState.AGENT_RESPONDING, event: SchedulerEvent.STOP, to: SchedulerState.STOPPED, action: () => this.onStop() },
    { from: SchedulerState.WAITING_USER_INPUT, event: SchedulerEvent.STOP, to: SchedulerState.STOPPED, action: () => this.onStop() },

    // Pause/resume
    { from: SchedulerState.IDLE, event: SchedulerEvent.PAUSE, to: SchedulerState.PAUSED, action: () => this.onPause() },
    { from: SchedulerState.SELECTING_AGENT, event: SchedulerEvent.PAUSE, to: SchedulerState.PAUSED, action: () => this.onPause() },
    { from: SchedulerState.PAUSED, event: SchedulerEvent.RESUME, to: SchedulerState.IDLE, action: () => this.onResume() },

    // Drain mode
    { from: SchedulerState.IDLE, event: SchedulerEvent.BEGIN_DRAIN, to: SchedulerState.DRAINING, action: () => this.onBeginDrain() },
    { from: SchedulerState.SELECTING_AGENT, event: SchedulerEvent.BEGIN_DRAIN, to: SchedulerState.DRAINING, action: () => this.onBeginDrain() },
    { from: SchedulerState.AGENT_RESPONDING, event: SchedulerEvent.BEGIN_DRAIN, to: SchedulerState.DRAINING, action: () => this.onBeginDrain() },
    { from: SchedulerState.DRAINING, event: SchedulerEvent.STOP_DRAIN, to: SchedulerState.IDLE, action: () => this.onStopDrain() },

    // Normal work flow
    { from: SchedulerState.IDLE, event: SchedulerEvent.WORK_AVAILABLE, to: SchedulerState.SELECTING_AGENT, action: () => this.resetIdleTicks() },
    { from: SchedulerState.SELECTING_AGENT, event: SchedulerEvent.AGENT_SELECTED, to: SchedulerState.AGENT_RESPONDING },
    { from: SchedulerState.AGENT_RESPONDING, event: SchedulerEvent.AGENT_COMPLETED, to: SchedulerState.IDLE, action: () => this.cleanupAgent() },
    { from: SchedulerState.AGENT_RESPONDING, event: SchedulerEvent.AGENT_NEEDS_USER, to: SchedulerState.WAITING_USER_INPUT },

    // User input handling
    { from: SchedulerState.WAITING_USER_INPUT, event: SchedulerEvent.USER_INPUT_RECEIVED, to: SchedulerState.PROCESSING_INTERJECTION },

    // Interjections
    { from: SchedulerState.IDLE, event: SchedulerEvent.INTERJECTION_RECEIVED, to: SchedulerState.PROCESSING_INTERJECTION },
    { from: SchedulerState.SELECTING_AGENT, event: SchedulerEvent.INTERJECTION_RECEIVED, to: SchedulerState.PROCESSING_INTERJECTION },
    { from: SchedulerState.PROCESSING_INTERJECTION, event: SchedulerEvent.INTERJECTION_PROCESSED, to: SchedulerState.IDLE, action: () => this.clearInterjection() },

    // Idle handling
    { from: SchedulerState.IDLE, event: SchedulerEvent.NO_WORK_AVAILABLE, to: SchedulerState.IDLE, action: () => this.incrementIdleTicks() },
    { from: SchedulerState.IDLE, event: SchedulerEvent.IDLE_TIMEOUT, to: SchedulerState.WAITING_USER_INPUT, guard: () => this.shouldPromptUser() },
    { from: SchedulerState.SELECTING_AGENT, event: SchedulerEvent.NO_WORK_AVAILABLE, to: SchedulerState.IDLE }
  ];

  constructor(opts: SchedulerOptionsWithBridge) {
    this.onStreamStart = opts.onStreamStart;
    this.onStreamEnd = opts.onStreamEnd;
    this.agents = opts.agents;
    this.maxTools = opts.maxTools;
    this.shuffle = opts.shuffle ?? fisherYatesShuffle;
    this.askUser = opts.onAskUser;

    this.promptEnabled = !!opts.promptEnabled;
    this.idleSleepMs = opts.idleSleepMs ?? 25;
    this.readUserLine = opts.readUserLine;

    for (const a of this.agents) {
      this.inbox.ensure(a.id);
    }
  }

  private async transition(event: SchedulerEvent): Promise<boolean> {
    const applicable = this.transitions.filter(t => 
      t.from === this.currentState && 
      t.event === event &&
      (!t.guard || t.guard())
    );

    if (applicable.length === 0) {
      Logger.debug(`FSM: No transition for ${event} from ${this.currentState}`);
      return false;
    }

    const transition = applicable[0];
    Logger.debug(`FSM: ${this.currentState} --${event}--> ${transition.to}`);
    
    this.currentState = transition.to;
    
    if (transition.action) {
      await transition.action();
    }
    
    return true;
  }

  // Main loop - preserves original structure
  async start(): Promise<void> {
    try {
      await this.transition(SchedulerEvent.START);
      
      while (this.currentState !== SchedulerState.STOPPED) {
        await this.tick();
        await sleep(this.idleSleepMs);
      }
    } catch (e) {
      Logger.error("Scheduler start failed.", e);
    } finally {
      for (const agent of this.agents) {
        agent.save();
      }
      if (this.keepAlive) {
        clearInterval(this.keepAlive);
        this.keepAlive = null;
      }
      this.running = false;
    }
  }

  private async tick(): Promise<void> {
    switch (this.currentState) {
      case SchedulerState.PAUSED:
      case SchedulerState.DRAINING:
        // Just wait
        break;
        
      case SchedulerState.IDLE:
        if (this.interjection) {
          await this.transition(SchedulerEvent.INTERJECTION_RECEIVED);
        } else if (this.inbox.hasAnyWork()) {
          await this.transition(SchedulerEvent.WORK_AVAILABLE);
        } else if (this.isIdleTimeout()) {
          await this.transition(SchedulerEvent.IDLE_TIMEOUT);
        } else {
          await this.transition(SchedulerEvent.NO_WORK_AVAILABLE);
        }
        break;
        
      case SchedulerState.SELECTING_AGENT:
        if (this.interjection) {
          await this.transition(SchedulerEvent.INTERJECTION_RECEIVED);
        } else {
          const agent = this.selectNextAgent();
          if (agent) {
            this.activeAgent = agent;
            await this.transition(SchedulerEvent.AGENT_SELECTED);
          } else {
            await this.transition(SchedulerEvent.NO_WORK_AVAILABLE);
          }
        }
        break;
        
      case SchedulerState.AGENT_RESPONDING:
        const result = await this.executeAgentWork();
        if (result.needsUser) {
          await this.transition(SchedulerEvent.AGENT_NEEDS_USER);
        } else {
          await this.transition(SchedulerEvent.AGENT_COMPLETED);
        }
        break;
        
      case SchedulerState.PROCESSING_INTERJECTION:
        await this.handleInterjection();
        await this.transition(SchedulerEvent.INTERJECTION_PROCESSED);
        break;
        
      case SchedulerState.WAITING_USER_INPUT:
        const input = await this.getUserInput();
        if (input) {
          this.interjection = input;
          await this.transition(SchedulerEvent.USER_INPUT_RECEIVED);
        }
        break;
    }
  }

  // State actions
  private onStart(): void {
    this.running = true;
    this.keepAlive = setInterval(() => {}, 30_000);
  }

  private onStop(): void {
    this.running = false;
    Logger.debug("stopped");
  }

  private onPause(): void {
    this.paused = true;
    Logger.debug("paused");
  }

  private onResume(): void {
    this.paused = false;
    Logger.debug("resumed");
  }

  private onBeginDrain(): void {
    this.draining = true;
  }

  private onStopDrain(): void {
    this.draining = false;
  }

  private resetIdleTicks(): void {
    this.idleTicks = 0;
  }

  private incrementIdleTicks(): void {
    this.idleTicks++;
  }

  private cleanupAgent(): void {
    this.activeAgent = undefined;
  }

  private clearInterjection(): void {
    this.interjection = undefined;
    this.rescheduleNow = false;
  }

  // Guards
  private shouldPromptUser(): boolean {
    return !this.inbox.hasAnyWork() && 
           (this.idleTicks % this.idlePromptEvery) === 0 && 
           this.promptEnabled;
  }

  private isIdleTimeout(): boolean {
    return !this.inbox.hasAnyWork() && 
           (this.idleTicks % this.idlePromptEvery) === 0 && 
           this.promptEnabled;
  }

  // Agent work - preserves original logic
  private selectNextAgent(): Agent | undefined {
    const ready = this.agents.filter((a) => this.inbox.hasWork(a.id));
    const order = this.shuffle(ready);
    
    for (const agent of order) {
      if (this.isMuted(agent.id)) {
        Logger.debug(`muted: ${agent.id}`);
        continue;
      }
      return this.respondingAgent ?? agent;
    }
    return undefined;
  }

  private async executeAgentWork(): Promise<{needsUser: boolean}> {
    if (!this.activeAgent) return {needsUser: false};

    const agent = this.activeAgent;
    this.respondingAgent = undefined;

    const messages = this.inbox.nextPromptFor(agent.id);
    if (messages.length === 0) {
      return {needsUser: false};
    }

    Logger.debug(`drained prompt for ${agent.id}:`, JSON.stringify(messages));

    let remaining = this.maxTools;
    const messagesIn = [...messages];
    let needsUser = false;

    try {
      const callbacks: AgentCallbacks = {
        onRouteCompleted: async (message, numToolsUsed, askedUser) => {
          if (numToolsUsed > 0) return false;

          const shouldUserRespond = askedUser || this.agents.length === 1 || !this.inbox.hasAnyWork();
          if (!shouldUserRespond) return false;

          needsUser = true;
          this.lastUserDMTarget = agent.id;
          return true;
        },
        shouldAbort: () => this.draining,
        onStreamStart: this.onStreamStart,
        onStreamEnd: this.onStreamEnd,
        onRoute: async (message: string, filters: NoiseFilters): Promise<boolean> => {
          return await routeWithSideEffects(
            {
              agents: this.agents,
              enqueue: (toId, msg) => this.inbox.push(toId, msg),
              setRespondingAgent: (id) => {
                this.respondingAgent = this.agents.find((x) => x.id === id);
              },
              applyGuard: (from, dec) => this.applyGuardDecision(agent, dec),
              setLastUserDMTarget: (id) => {
                this.lastUserDMTarget = id;
              },
            },
            this,
            message,
            filters
          );
        }
      };

      await agent.respond(
        messagesIn,
        Math.max(0, remaining),
        this.filters,
        this.agents.filter(a => a.id !== agent.id),
        callbacks
      );

    } catch (error) {
      Logger.error(`Agent ${agent.id} execution failed:`, error);
    }

    return {needsUser};
  }

  // User input handling - preserves original logic
  private async getUserInput(): Promise<string | undefined> {
    if (!this.inbox.hasAnyWork() && this.promptEnabled) {
      if (typeof this.readUserLine === "function") {
        return await this.readUserLine();
      } else {
        const peers = this.agents.map((x) => x.id);
        const dec = this.agents[0]?.guardOnIdle?.({
          idleTicks: this.idleTicks,
          peers,
          queuesEmpty: true,
        }) || null;
        
        const prompt = (dec as any)?.askUser ?? 
          `(scheduler) All agents are idle. Provide the next concrete instruction or question.`;
        const preferred = this.agents[0]?.id;
        if (preferred) this.lastUserDMTarget = preferred;
        
        return await this.askUser("scheduler", prompt);
      }
    }
    return undefined;
  }

  private async handleInterjection(): Promise<void> {
    if (!this.interjection) return;

    await this.handleUserInterjection(this.interjection, {
      defaultTargetId: this.lastUserDMTarget ?? undefined,
    });
  }

  // Preserved from original RandomScheduler
  private async handleUserInterjection(text: string, opts?: { defaultTargetId?: string }) {
    const raw = String(text ?? "");
    const parts = TagSplitter.split(raw, {
      userTokens: ["user"],
      groupTokens: ["group"],
      agentTokens: this.agents.map((a) => a.id),
      fileTokens: ["file"],
      allowFileShorthand: false,
    });

    const agentParts = parts.filter((p) => p.kind === "agent") as Array<TagPart & { kind: "agent" }>;

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
          const msg: ChatMessage = { content: ap.content, role: "user", from: "User" };
          this.inbox.push(ag.id, msg);
          Logger.info(`[user → @@${ag.id}] ${raw}`);
        }
        this.rescheduleNow = true;
        return;
      }
    }

    if (opts?.defaultTargetId) {
      const ag = this.findAgentByIdExact(opts.defaultTargetId);
      if (ag) {
        const msg: ChatMessage = { content: raw.trim(), role: "user", from: "User" };
        this.respondingAgent = ag;
        this.lastUserDMTarget = ag.id;
        this.inbox.push(ag.id, msg);
        Logger.info(`[user → @@${ag.id} (def)] ${raw}`);
        this.rescheduleNow = true;
        return;
      }
    }

    for (const a of this.agents) {
      this.inbox.push(a.id, { content: raw.trim(), role: "user", from: "User" });
    }
    Logger.info(`[user → @@group] ${raw}`);
  }

  // Utility methods - preserved from original
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
      this.lastUserDMTarget = agent.id;
      const userText = await this.getUserText(agent.id, dec.askUser);
      if (userText?.trim()) {
        await this.handleUserInterjection(userText, { defaultTargetId: agent.id });
      }
    }
  }

  private async getUserText(label: string, prompt: string): Promise<string> {
    if (typeof this.readUserLine === "function") {
      Logger.info(`[${label}] ${prompt}`);
      return ((await this.readUserLine()) ?? "").trim();
    }
    return ((await this.askUser(label, prompt)) ?? "").trim();
  }

  private findAgentByIdExact(key: string): Agent | undefined {
    const t = key.toLowerCase();
    return this.agents.find((a) => a.id.toLowerCase() === t);
  }

  // Public API - matches original RandomScheduler
  stop() { this.transition(SchedulerEvent.STOP); }
  pause() { this.transition(SchedulerEvent.PAUSE); }
  resume() { this.transition(SchedulerEvent.RESUME); }

  async drain(): Promise<boolean> {
    if (this.draining) return false;
    await this.transition(SchedulerEvent.BEGIN_DRAIN);
    while (this.hasActiveAgent()) {
      Logger.info(C.magenta(`\nWaiting for agent to complete...`));
      await sleep(1000);
    }
    return true;
  }

  stopDraining(): void { this.transition(SchedulerEvent.STOP_DRAIN); }
  isDraining(): boolean { return this.draining; }
  hasActiveAgent(): boolean { return !!this.activeAgent; }

  async interject(text: string) {
    this.interjection = text;
  }
}
