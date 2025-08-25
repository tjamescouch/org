import type { ChatMessage, ToolCall } from './types';
import { sleep } from './utils/sleep';

/** A tiny provider abstraction so we can swap mock for real later. */
export interface Provider {
  chat(messages: ChatMessage[], opts: { model: string }): Promise<{ toolCalls: ToolCall[]; finalText?: string }>;
}

/**
 * MockProvider simulates a model that sometimes asks for tools.
 * Rules:
 *  - if last user mentions "time" -> tool: date
 *  - if mentions "calc x" or "calc(x)" -> tool: calc
 *  - if mentions "echo: ..." -> tool: echo
 *  - otherwise, 50% produce final text with no tools (yield after one hop)
 */
export class MockProvider implements Provider {
  async chat(messages: ChatMessage[], _opts: { model: string }) {
    await sleep(1000);

    const last = messages[messages.length - 1];
    const text = String(last?.content || '').toLowerCase();
    const calls: ToolCall[] = [];
    if (/\btime\b/.test(text)) {
      calls.push({ name: 'date', args: {} });
    }
    const calcMatch = text.match(/calc\s*\(?\s*([0-9+\-*/().\s]+)\s*\)?/);
    if (calcMatch) {
      calls.push({ name: 'calc', args: { expr: calcMatch[1] } });
    }
    const echoMatch = text.match(/echo:\s*(.+)$/);
    if (echoMatch) {
      calls.push({ name: 'echo', args: { text: echoMatch[1] } });
    }
    if (calls.length === 0) {
      if (Math.random() < 0.25) {
        return { toolCalls: [], finalText: "Okay. (no tools needed)" };
      } else if (Math.random() < 0.5) {
        return { toolCalls: [], finalText: "@@user done" };
      }
      // otherwise ask for a date for fun
      return { toolCalls: [{ name: 'date', args: {} }], finalText: undefined };
    }
    return { toolCalls: calls, finalText: undefined };
  }
}

