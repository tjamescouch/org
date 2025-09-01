type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  role: string;
  from: string;
  content: string;
}

interface ToolCall {
  name: string;
  args: Record<string, any>;
}

interface ToolResult {
  name: string;
  content: string;
}

