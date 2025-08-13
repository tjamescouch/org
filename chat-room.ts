// chat-room.ts
import type { AgentModel } from "./agent-model";

export type Role = "system" | "user" | "assistant" | "tool";

export interface RoomMessage {
  ts: string;
  role: Role;
  from: string;
  content: string;
  read: boolean;
}

/**
 * Minimal message bus for the agents.
 * - broadcast(from, content, directTo?)
 * - hasFreshUserMessage(): true for a short TTL after a user post (scheduler hint)
 */
export class ChatRoom {
  private models: AgentModel[] = [];
  private lastUserTs = 0;            // for hasFreshUserMessage()

  addModel(m: AgentModel) {
    this.models.push(m);
  }

  /**
   * Broadcast a message to all agents (or one, if directTo is set).
   * `from` should be "User", "System", or an agent id.
   */
  async broadcast(from: string, content: string, directTo?: string): Promise<void> {
    const ts = new Date().toISOString();
    const role: Role =
      from.toLowerCase() === "system" ? "system" :
      from.toLowerCase() === "assistant" ? "assistant" : "user";

    const msg: RoomMessage = { ts, role, from, content, read: false };

    if (directTo) {
      const target = directTo.toLowerCase();
      for (const m of this.models) {
        if ((m as any).id?.toLowerCase?.() === target) m.enqueueFromRoom(msg);
      }
    } else {
      for (const m of this.models) m.enqueueFromRoom(msg);
    }

    if (role === "user") this.lastUserTs = Date.now();
  }

  /**
   * Used by TurnManager to prioritize a burst after user input.
   * Returns true for a short window after a user message.
   */
  hasFreshUserMessage(): boolean {
    return Date.now() - this.lastUserTs < 2000; // ~2s hint window
  }

  async shutdown(): Promise<void> {
    // no-op for now; place for flushing logs or closing resources
  }
}