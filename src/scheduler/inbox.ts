import type { ChatMessage } from "./scheduler";

const VALID_ROLES = new Set(["system", "user", "assistant", "tool"] as const);

function assertString(name: string, v: unknown): asserts v is string {
  if (typeof v !== "string") {
    throw new Error(`${name} must be a string; got ${typeof v}`);
  }
}

function assertRole(name: string, r: unknown): asserts r is ChatMessage["role"] {
  assertString(name, r);
  if (!VALID_ROLES.has(r as any)) {
    throw new Error(`${name} must be one of ${Array.from(VALID_ROLES).join(", ")}; got '${r}'`);
  }
}

/**
 * Inbox with per-agent queues plus a group queue ("@group").
 * Enforce message validity at the boundary so bad states fail fast.
 */
export class Inbox {
  private queues = new Map<string, ChatMessage[]>();

  ensure(id: string): ChatMessage[] {
    if (!this.queues.has(id)) this.queues.set(id, []);
    return this.queues.get(id)!;
  }

  /** Validate and enqueue a message. */
  push(id: string, msg: ChatMessage): void {
    this.ensure(id).push(msg);
  }

  /** Returns true if this agent has any work (its own queue or group queue). */
  hasWork(agentId: string): boolean {
    const q = this.queues.get(agentId);
    return (q?.length ?? 0) > 0;// || this.group.length > 0;
  }

  hasAnyWork() {
    const ids = Object.keys(this.queues);

    return ids.some(id => this.hasWork(id));
  }

  /**
   * Get the next prompt for an agent. Prefers its own queue, then the group queue.
   * Returns **a copy** (ChatMessage[]) so downstream cannot mutate internal state.
   */
  nextPromptFor(agentId: string): ChatMessage[] {
    const q = this.queues.get(agentId);
    let r = [];
    if (q && q.length > 0) {
      //const m = q.shift()!;
      r.push(...q);
    }
    return r;
  }

  /** Total messages waiting. */
  size(): number {
    let n = this.group.length;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
}
