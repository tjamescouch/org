export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatOutput {
  text: string;               // assistant text (may be empty)
  toolCalls: ChatToolCall[];  // zero or more tool calls requested by the model
}

export interface ChatDriver {
  chat(messages: ChatMessage[], opts?: { model?: string; tools?: any[] }): Promise<ChatOutput>;
}
