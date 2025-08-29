import type { ChatMessage } from "./scheduler";

/**
 * Simple inbox with a group queue ("@group") and per-agent queues.
 * This is intentionally conservative: for now we hand one message at a time
 * to an agent (as a ChatMessage[]) and let the agent track its own memory.
 */
export class Inbox {
  private group: ChatMessage[] = [];
  private perAgent = new Map<string, ChatMessage[]>();

  /** Push a message. If `to` is not set or "@group", it goes to the group queue. */
  enqueue(msg: ChatMessage): void {
    const to = msg.to ?? "group";
    if (to === "group") {
      this.group.push(msg);
    } else {
      const q = this.perAgent.get(to) ?? [];
      q.push(msg);
      this.perAgent.set(to, q);
    }
  }

  /** Returns true if this agent has any work (its own queue or group queue). */
  hasWork(agentId: string): boolean {
    const q = this.perAgent.get(agentId);
    return (!!q && q.length > 0) || this.group.length > 0;
  }

  /**
   * Get the next prompt for an agent. Prefers its own queue, then the group queue.
   * Returns an array so agents always receive ChatMessage[].
   */
  nextPromptFor(agentId: string): ChatMessage[] {
    const q = this.perAgent.get(agentId);
    if (q && q.length > 0) {
      return [q.shift()!];
    }
    if (this.group.length > 0) {
      return [this.group.shift()!];
    }
    return [];
  }

  /** Total messages waiting. */
  size(): number {
    let n = this.group.length;
    for (const q of this.perAgent.values()) n += q.length;
    return n;
  }
}

export default Inbox;
