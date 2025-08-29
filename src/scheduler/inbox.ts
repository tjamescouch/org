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
export default class Inbox {
  private group: ChatMessage[] = [];
  private perAgent = new Map<string, ChatMessage[]>();

  /** Validate and enqueue a message. */
  enqueue(msg: ChatMessage): void {
    if (msg == null || typeof msg !== "object") {
      throw new Error("enqueue: message must be an object");
    }
    assertRole("message.role", msg.role);
    assertString("message.content", msg.content);
    const contentTrim = msg.content.trim();
    if (!contentTrim) throw new Error("enqueue: message.content is empty");
    if (/^\s*undefined\s*:/i.test(contentTrim)) {
      throw new Error("enqueue: message.content appears corrupted (starts with 'undefined:')");
    }

    if (msg.from !== undefined) {
      assertString("message.from", msg.from);
      if (!msg.from.trim()) throw new Error("enqueue: message.from is empty");
    }
    if (msg.to !== undefined) {
      assertString("message.to", msg.to);
      if (!msg.to.trim()) throw new Error("enqueue: message.to is empty");
    }

    const to = (msg.to ?? "@group").trim();
    const clean: ChatMessage = {
      role: msg.role,
      content: contentTrim,
      ...(msg.from ? { from: msg.from.trim() } : {}),
      ...(to ? { to } : {}),
    };

    if (to === "@group") {
      this.group.push(clean);
    } else {
      const q = this.perAgent.get(to) ?? [];
      q.push(clean);
      this.perAgent.set(to, q);
    }
  }

  /** Returns true if this agent has any work (its own queue or group queue). */
  hasWork(agentId: string): boolean {
    const q = this.perAgent.get(agentId);
    return (q?.length ?? 0) > 0 || this.group.length > 0;
  }

  /**
   * Get the next prompt for an agent. Prefers its own queue, then the group queue.
   * Returns **a copy** (ChatMessage[]) so downstream cannot mutate internal state.
   */
  nextPromptFor(agentId: string): ChatMessage[] {
    const q = this.perAgent.get(agentId);
    if (q && q.length > 0) {
      const m = q.shift()!;
      return [{ ...m }];
    }
    if (this.group.length > 0) {
      const m = this.group.shift()!;
      return [{ ...m }];
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
