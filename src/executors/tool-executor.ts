// src/executors/tool-executor.ts
import type { ChatToolCall } from "../drivers/types";
import type { AgentMemory } from "../memory";
import type { GuardRail } from "../guardrails/guardrail";

export interface ExecuteToolsParams {
  calls: ChatToolCall[];
  maxTools: number;
  abortCallback: () => boolean;
  guard: GuardRail;
  memory: AgentMemory;
  finalText: string; // used for assistant memory in certain branches
  agentId: string;   // for logging context
}

export interface ExecuteToolsResult {
  toolsUsed: number;
  forceEndTurn: boolean;
}

/**
 * Abstract executor for tool calls.
 * Implementations must preserve semantics expected by LlmAgent.
 */
export abstract class ToolExecutor {
  abstract execute(params: ExecuteToolsParams): Promise<ExecuteToolsResult>;
}
