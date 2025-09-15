import { AdvancedGuardRail } from "../guardrails/advanced-guardrail";
import { GuardDecision, GuardRail, GuardRouteKind } from "../guardrails/guardrail";
import { NoiseFilters } from "../scheduler/filters";
import { ChatMessage } from "../types";

export interface AgentReply {
  message: string;   // assistant text
  reasoning?: string;
  toolsUsed: number; // number of tool calls consumed this hop
}

export type AgentCallbacks = {
  onEnqueue: (to: string, msg: ChatMessage) => void;
  onApplyGuardDecision: (agent: Agent, dec: GuardDecision) => Promise<void>;
  onSetLastUserDMTarget: (id: string) => void;
  onSetRespondingAgent: (id?: string) => void;
  onAbort: () => boolean,
  onStreamStart: () => void;
  onStreamEnd: () => void | Promise<void>;
  onAskedUser: (message: string) => Promise<void>;
  onRoute: (message: string, filters: NoiseFilters) => Promise<boolean>;
};


export abstract class Agent {
  // Guard rails (loop / quality signals), per-agent, pluggable.
  protected readonly guard: GuardRail;
  public readonly id: string;

  constructor(id: string, guard?: GuardRail) {
    this.id = id;
    this.guard = guard ?? new AdvancedGuardRail({ agentId: id });
  }

  abstract respond(messages: ChatMessage[], maxTools: number, filters: NoiseFilters, peers: Agent[], callbacks: AgentCallbacks): Promise<AgentReply[]>;

  formatMessage(message: ChatMessage): ChatMessage {
    return {
        ...message,
        content: `${message.from}: ${message.content}`,
    };
  }

  guardCheck(route: GuardRouteKind, content: string, peers: string[]) {
    return this.guard.guardCheck(route, content, peers);
  }

  /** Allow scheduler to ask this agent's guard rail for idle fallbacks. */
  guardOnIdle(state: { idleTicks: number; peers: string[]; queuesEmpty: boolean }) {
    const anyGuard: any = this.guard as any;
    return typeof anyGuard.onIdle === 'function' ? anyGuard.onIdle(state) : null;
  }

  abstract load(): Promise<void>;
  abstract save(): Promise<void>;
}
