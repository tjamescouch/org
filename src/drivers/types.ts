export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  /** When role==="tool", the id of the tool call being answered (OpenAI). */
  tool_call_id?: string;
  /** Optional: tool/function name for clarity */
  name?: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatOutput {
  text: string;               // assistant text (may be empty)
  reasoning?: string;
  toolCalls: ChatToolCall[];  // zero or more tool calls requested by the model
  reasoning?: string;
}

export interface ChatDriver {
  chat(messages: ChatMessage[], opts?: { model?: string; tools?: any[] }): Promise<ChatOutput>;
}
