import type { ChatMessage } from "../drivers/types";

/**
 * Base class for agent memory.
 * Concrete classes should implement summarizeIfNeeded() using a non-blocking strategy.
 */
export abstract class AgentMemory {
  protected readonly messagesBuffer: ChatMessage[] = [];

  // Background summarization coordination
  private summarizing = false;
  private pending = false;

  constructor(systemPrompt?: string) {
    if (systemPrompt && systemPrompt.trim().length > 0) {
      this.messagesBuffer.push({ role: "system", content: systemPrompt });
    }
  }

  async add(msg: ChatMessage): Promise<void> {
    this.messagesBuffer.push(msg);
    // schedule summarization but don't block caller
    await this.onAfterAdd();
  }

  /** Hook for subclasses. Should schedule summarization but return quickly. */
  protected abstract onAfterAdd(): Promise<void>;

  /** Access snapshot of messages for sending to model. */
  messages(): ChatMessage[] {
    return [...this.messagesBuffer];
  }

  /** Utility for subclasses: count excluding first system message. */
  protected nonSystemCount(): number {
    if (this.messagesBuffer.length === 0) return 0;
    return this.messagesBuffer[0].role === "system" ? this.messagesBuffer.length - 1 : this.messagesBuffer.length;
  }

  /** Run a background task once. Subclasses can use to serialize summarization. */
  protected async runOnce(task: () => Promise<void>): Promise<void> {
    if (this.summarizing) { this.pending = true; return; }
    this.summarizing = true;
    try {
      await task();
    } finally {
      this.summarizing = false;
      if (this.pending) {
        this.pending = false;
        // Fire and forget; don't await a chain.
        void this.runOnce(task);
      }
    }
  }
}
