import type { ChatMessage } from "../drivers/types";

/**
 * Abstract memory for an agent. Concrete implementations decide how to
 * store/trim/summarize when the history grows.
 *
 * Lifecycle:
 *  - The constructor may seed an initial system prompt.
 *  - Call `add()` for every message the agent wants to remember.
 *  - Call `messages()` when sending context to the model.
 */
export abstract class AgentMemory {
  protected readonly messagesBuffer: ChatMessage[] = [];

  constructor(systemPrompt?: string) {
    if (systemPrompt && systemPrompt.trim().length > 0) {
      this.messagesBuffer.push({ role: "system", content: systemPrompt });
    }
  }

  /** Append a message and allow the implementation to maintain invariants. */
  async add(msg: ChatMessage): Promise<void> {
    this.messagesBuffer.push(msg);
    await this.onAfterAdd();
  }

  /** All messages to provide to the driver (copy, not the live buffer). */
  messages(): ChatMessage[] {
    // Return a shallow copy to avoid accidental mutation by callers.
    return [...this.messagesBuffer];
  }

  /** Number of messages excluding the initial system prompt (if present). */
  protected nonSystemCount(): number {
    if (this.messagesBuffer.length === 0) return 0;
    const first = this.messagesBuffer[0];
    return first?.role === "system" ? this.messagesBuffer.length - 1 : this.messagesBuffer.length;
  }

  /** Implementations can summarize/trim/etc. Called after each add(). */
  protected abstract onAfterAdd(): Promise<void>;
}
