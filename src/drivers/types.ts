export interface ChatMessage {
  role: string;
  from: string;
  content: string;
  reasoning?: string;
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
  toolCalls: ChatToolCall[];  // zero or more tool calls requested by the model
  reasoning?: string;
}

export interface ChatDriver {
  chat(messages: ChatMessage[], opts?: { model?: string; tools?: any[], onToken?: (s: string) => void, onReasoningToken?: (s: string) => void }): Promise<ChatOutput>;
}
