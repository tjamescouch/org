// src/scheduler/inbox.ts
import type { ChatMessage } from "../types";

/**
 * Per-agent FIFO queues. No policy here — just storage.
 * Small, testable, single responsibility.
 */
export class Inbox {
  private queues = new Map<string, ChatMessage[]>();

  ensure(id: string): ChatMessage[] {
    if (!this.queues.has(id)) this.queues.set(id, []);
    return this.queues.get(id)!;
  }

  push(id: string, msg: ChatMessage): void {
    this.ensure(id).push(msg);
  }

  shift(id: string): void {
    this.ensure(id).shift();
  }

  /** Drain all pending messages for an agent. */
  drain(id: string): ChatMessage[] {
    const q = this.ensure(id);
    const out = q.slice();
    q.length = 0;
    return out;
  }

  /** Are there any messages for the given agent? */
  hasWork(id: string): boolean {
    return (this.queues.get(id) ?? []).length > 0;
  }

  hasAnyWork(ids?: string[]): boolean {
    const all = ids ?? Object.keys(this.queues);
    return all.some(id => this.hasWork(id));
  }

  /** True iff *every* queue is currently empty. (Fixed inversion bug.) */
  allEmpty(ids?: string[]): boolean {
    const all = ids ?? Object.keys(this.queues);
    for (const id of all) {
      if (this.hasWork(id)) return false; // <- correct: any work => not all empty
    }
    return true;
  }
}
