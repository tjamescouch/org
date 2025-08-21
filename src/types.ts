export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  role: string;
  from: string;
  content: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  name: string;
  content: string;
}

