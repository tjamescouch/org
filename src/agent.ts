import type { ChatMessage, ToolCall } from './types';
import type { Provider } from './provider';
import { defaultRegistry } from './tools';
import { Logger, Colors } from './logger';

function colorFor(id: string): string {
  const h = Array.from(id).reduce((a, c) => (a*33 + c.charCodeAt(0)) >>> 0, 5381);
  const palette = [Colors.FgCyan, Colors.FgGreen, Colors.FgBlue, Colors.FgMagenta, Colors.FgYellow];
  return palette[h % palette.length];
}

export class Agent {
  readonly id: string;
  readonly model: string;
  private provider: Provider;
  private history: ChatMessage[] = [];
  private inbox: string[] = [];

  constructor(id: string, model: string, provider: Provider) {
    this.id = id; this.model = model; this.provider = provider;
    this.history.push({ role: 'system', content: `You are agent "${id}". Prefer using tools when asked.`, from: 'system' });
  }

  receiveUserPrompt(text: string) {
    this.inbox.push(text);
  }

  hasWork(): boolean { return this.inbox.length > 0; }

  private say(text: string) {
    Logger.info(`${colorFor(this.id)}${this.id}${Colors.Reset}: ${text}`);
  }

  /** Run a single round for this agent with up to maxTools tool executions. */
  async runTurn(maxTools: number): Promise<void> {
    if (!this.hasWork()) return;
    const prompt = this.inbox.shift()!;
    this.history.push({ role: 'user', from: 'User', content: prompt });

    let remaining = Math.max(0, maxTools);
    // one or more hops
    while (true) {
      const res = await this.provider.chat(this.history, { model: this.model });
      if (!res.toolCalls.length) {
        // no tools requested → yield immediately, but if provider gave a text, show it
        if (res.finalText) {
          this.say(res.finalText);
          this.history.push({ role: 'assistant', from: this.id, content: res.finalText });
        }
        return;
      }
      // execute requested tools up to the budget
      for (const call of res.toolCalls) {
        if (remaining <= 0) {
          this.say(`(tool budget exhausted)`);
          return;
        }
        const toolRes = await defaultRegistry.exec(call);
        this.say(`$ ${call.name} -> ${toolRes.content}`);
        this.history.push({ role: 'tool', from: call.name, content: toolRes.content });
        remaining--;
      }
      // after executing tools, ask model again with new context (next hop)
    }
  }
}

