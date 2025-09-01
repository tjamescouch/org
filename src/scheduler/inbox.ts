import type { ChatMessage } from "../types";

/**
 * Per-agent inbox with simple FIFO queues.
 * Important: nextPromptFor() DRAINS the queue atomically.
 */
export class Inbox {
  private queues = new Map<string, ChatMessage[]>();

  ensure(id: string): void {
    if (!this.queues.has(id)) this.queues.set(id, []);
  }

  /** Push a single message for an agent. */
  push(id: string, msg: ChatMessage): void {
    this.ensure(id);
    this.queues.get(id)!.push(msg);
  }

  /** Push many messages at once. */
  pushAll(id: string, msgs: ChatMessage[]): void {
    if (!msgs?.length) return;
    this.ensure(id);
    const q = this.queues.get(id)!;
    for (const m of msgs) q.push(m);
  }

  /** Whether an agent has any pending work. */
  hasWork(id: string): boolean {
    const q = this.queues.get(id);
    return !!q && q.length > 0;
  }

  /** Whether any agent has work. */
  hasAnyWork(): boolean {
    for (const [, q] of this.queues) if (q.length > 0) return true;
    return false;
  }

  /**
   * Drain all pending messages for an agent and return them as a batch.
   * If empty, returns [] and leaves the queue empty.
   *
   * This is intentionally destructive; callers must re‑enqueue if they need
   * the items again. This prevents infinite reprocessing loops.
   */
  nextPromptFor(id: string): ChatMessage[] {
    const q = this.queues.get(id);
    if (!q || q.length === 0) return [];
    // Drain atomically
    return q.splice(0, q.length);
  }

  /** Inspect (without consuming) the current queue length. Useful in tests. */
  size(id: string): number {
    return this.queues.get(id)?.length ?? 0;
  }

  /** Clear an agent queue (mainly for tests and safety). */
  clear(id: string): void {
    const q = this.queues.get(id);
    if (q) q.length = 0;
  }
}

export default Inbox;
