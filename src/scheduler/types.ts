import type { ISandboxSession } from "../sandbox/types";
import type { ChatMessage } from "../types";
import type { GuardDecision, GuardRouteKind } from "../guardrails/guardrail";

/**
 * Minimal surface the scheduler needs from an agent implementation.
 * Keep this stable; other parts of the system (tests, UI) depend on it.
 */
export interface Responder {
  id: string;
  respond(
    messages: ChatMessage[],
    maxTools: number,
    peers: string[],
    abortCallback: () => boolean
  ): Promise<{ message: string; toolsUsed: number }[]>;
  /**
   * Optional guard hook invoked by the scheduler when the system is idle.
   * Agents may request a user prompt or suggest a nudge.
   */
  guardOnIdle?: (state: { idleTicks: number; peers: string[]; queuesEmpty: boolean }) => GuardDecision | null;
  /**
   * Optional per-message guard hook used during @@group delivery.
   * Can request to suppress broadcast, add a nudge, ask the user, or mute temporarily.
   */
  guardCheck?: (route: GuardRouteKind, content: string, peers: string[]) => GuardDecision | null;
}

export type AskUserFn = (fromAgent: string, content: string) => Promise<void>;


export type SchedulerOptions = {
  agents: Responder[];
  maxTools: number;
  projectDir: string;
  reviewMode?: "ask" | "never" | "auto"
  onAskUser: AskUserFn;
  promptEnabled?: boolean;
  idleSleepMs?: number;
  shuffle?: <T>(arr: T[]) => T[];
  sandbox: ISandboxSession;            // <-- NEW (required)
};
