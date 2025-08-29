import type { ChatMessage } from "./scheduler";

/**
 * Inbox with per-agent queues plus a group queue ("@group").
 * We dequeue **one** message at a time for an agent as ChatMessage[].
 */
export class Inbox {
  private group: ChatMessage[] = [];
  private perAgent = new Map<string, ChatMessage[]>();

  enqueue(msg: ChatMessage): void {
    const to = msg.to ?? "@group";
    if (to === "@group") {
      this.group.push(msg);
    } else {
      const q = this.perAgent.get(to) ?? [];
      q.push(msg);
      this.perAgent.set(to, q);
    }
  }

  hasWork(agentId: string): boolean {
    const q = this.perAgent.get(agentId);
    return (q && q.length > 0) || this.group.length > 0;
  }

  /** Prefer the agent's own queue, then the group queue. */
  nextPromptFor(agentId: string): ChatMessage[] {
    const q = this.perAgent.get(agentId);
    if (q && q.length > 0) return [q.shift()!];
    if (this.group.length > 0) return [this.group.shift()!];
    return [];
  }

  size(): number {
    let n = this.group.length;
    for (const q of this.perAgent.values()) n += q.length;
    return n;
  }
}

export default Inbox;
