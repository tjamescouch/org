import type { ChatMessage } from './types';
import type { Provider } from './provider';
import { defaultRegistry } from './tools';
import { Logger, Colors } from './logger';

function colorFor(id: string): string {
  const h = Array.from(id).reduce((a, c) => (a*33 + c.charCodeAt(0)) >>> 0, 5381);
  const palette = [Colors.FgCyan, Colors.FgGreen, Colors.FgBlue, Colors.FgMagenta, Colors.FgYellow];
  return palette[h % palette.length];
}

/** Focus: an agent that can run a single turn with a tool budget. */
export class Agent {
  readonly id: string;
  readonly model: string;
  private provider: Provider;
  private history: ChatMessage[] = [];
  private inbox: string[] = [];

  /** caller wires this to broadcast assistant speech to other agents */
  private onSpeak?: (fromId: string, text: string) => void;

  constructor(id: string, model: string, provider: Provider) {
    this.id = id; this.model = model; this.provider = provider;
    this.history.push({ role: 'system', content: `You are agent "${id}". Prefer using tools when asked.`, from: 'system' });
  }

  setOnSpeak(fn: (fromId: string, text: string) => void) { this.onSpeak = fn; }

  receiveUserPrompt(text: string) {
    this.inbox.push(text);
  }

  hasWork(): boolean { return this.inbox.length > 0; }

  private say(text: string) {
    Logger.info(`${colorFor(this.id)}${this.id}${Colors.Reset}: ${text}`);
  }

  private speakToGroup(text: string) {
    if (!text) return;
    this.onSpeak?.(this.id, text);
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

      // If the provider didn't request tools, yield immediately.
      if (!res.toolCalls.length) {
        if (res.finalText) {
          this.say(res.finalText);
          this.history.push({ role: 'assistant', from: this.id, content: res.finalText });
          // NEW: broadcast final text to other agents to keep the conversation flowing
          this.speakToGroup(res.finalText);
        }
        return;
      }

      // Execute requested tools up to the per-turn budget.
      for (const call of res.toolCalls) {
        if (remaining <= 0) {
          const note = `(tool budget exhausted)`;
          this.say(note);
          this.speakToGroup(note);
          return;
        }
        const toolRes = await defaultRegistry.exec(call);

        // Print the tool line locally
        const line = `$ ${call.name} -> ${toolRes.content}`;
        this.say(line);

        // Record tool output in history for the next hop
        this.history.push({ role: 'tool', from: call.name, content: toolRes.content });

        // NEW: also broadcast a short version to the group so others can react
        const short = toolRes.content.length > 120 ? toolRes.content.slice(0, 120) + '…' : toolRes.content;
        this.speakToGroup(`$ ${call.name} -> ${short}`);

        remaining--;
      }
      // After executing tools, the loop continues to ask the provider again with the extended context.
    }
  }
}
