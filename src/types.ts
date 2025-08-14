// src/types.ts
// Shared core types used across transport, models, tools, and UI.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  /** Optional agent identifier for multi-agent rooms */
  from?: string;
  /** Optional recipient when directly addressing another agent */
  to?: string;
  /** Natural language content or tool result text */
  content?: string;
  /** Opaque tool call correlation id (when role === "tool") */
  tool_call_id?: string;
  /** Raw streaming tokens (for SSE assemblers) */
  _delta?: string;
}

/** Tool schema passed to the model runtime (OpenAI-style mini subset) */
export interface ToolDef {
  name: string;
  description?: string;
  // Simple JSON-schema-like shape for arguments (keep it loose for now)
  parameters?: Record<string, unknown>;
}

/** A single tool call emitted by the model */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown; // parsed object or stringified JSON
}

/** Result of executing a tool call */
export interface ToolResult {
  id: string;      // echoes ToolCall.id
  name: string;    // echoes ToolCall.name
  result: unknown; // any JSON-serializable payload
  error?: string;  // present if tool failed
}

export type ToolExecutor = (call: ToolCall) => Promise<ToolResult>;