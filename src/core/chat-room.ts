// src/core/chat-room.ts
// Lightweight ChatRoom with default '@group' routing for messages that do not
// specify an explicit recipient. Designed to be drop-in simple and avoid
// monkey‑patching or other runtime tricks.

import type { Model } from "./entity/model";

export type Role = "user" | "assistant" | "tool";

export interface RoomMessage {
  from: string;          // sender model id or 'User'
  to: string;            // recipient model id or '@group'
  role: Role;
  content: string;
}

/** Public API that models can rely on once attached to a ChatRoom. */
export interface RoomAPI {
  sendTo(senderId: string, recipientId: string, content: string): Promise<void>;
  broadcast(senderId: string, content: string): Promise<void>;
  hasFreshUserMessage(): boolean;
}

/** Minimal event bus used by tests (room.events.on('send', ...)) */
class EventBus {
  private listeners: Map<string, Set<Function>> = new Map();

  on(event: string, fn: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }
  off(event: string, fn: Function) {
    this.listeners.get(event)?.delete(fn);
  }
  emit(event: string, payload: any) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { (fn as any)(payload); } catch { /* ignore */ }
    }
  }
}

/**
 * ChatRoom manages a set of Models and routes messages between them.
 * - If no explicit target is provided, we route to @group by default.
 * - We track the timestamp of the most recent user-originating message so
 *   callers (scheduler/tests) can check for "fresh" user input.
 */
export class ChatRoom implements RoomAPI {
  public readonly events = new EventBus();
  public readonly models: Map<string, Model> = new Map();

  // ms since epoch of the most recent message from the human user
  private lastUserTs = 0;

  // Window used by hasFreshUserMessage(); chosen to match existing tests (~2s)
  private readonly freshWindowMs: number;

  constructor(opts?: { freshWindowMs?: number }) {
    this.freshWindowMs = opts?.freshWindowMs ?? 2000;
  }

  addModel(model: Model) {
    if (this.models.has(model.id)) {
      throw new Error(`Model id already in room: ${model.id}`);
    }
    this.models.set(model.id, model);
    try { (model as any).onAttach?.(this as unknown as RoomAPI); } catch {}
  }

  removeModel(id: string) {
    const m = this.models.get(id);
    this.models.delete(id);
    try { (m as any)?.onDetach?.(); } catch {}
  }

  /** True if a user message was seen within the freshness window. */
  hasFreshUserMessage(): boolean {
    return Date.now() - this.lastUserTs < this.freshWindowMs;
  }

  /** Internal: deliver a message object to one or more models. */
  private async deliver(msg: RoomMessage): Promise<void> {
    this.events.emit("send", msg);

    if (msg.to === "@group") {
      // Fanout to all agents in the room
      const deliveries: Promise<any>[] = [];
      for (const [id, model] of this.models) {
        // Skip echo to the same model if the sender is an agent in the room
        if (id === msg.from) continue;
        try {
          deliveries.push((model as any).receiveMessage(msg));
        } catch {
          // ignore individual delivery errors to avoid blocking fanout
        }
      }
      await Promise.allSettled(deliveries);
      return;
    }

    // Direct message
    const target = this.models.get(msg.to);
    if (target) {
      try { await (target as any).receiveMessage(msg); } catch {}
    }
  }

  /** Send a message to a specific recipient. */
  async sendTo(senderId: string, recipientId: string, content: string): Promise<void> {
    // Treat falsy/empty recipient as group by default.
    const to = (recipientId && recipientId.trim().length > 0) ? recipientId : "@group";
    const role: Role = senderId === "User" ? "user" : "assistant";

    if (role === "user") this.lastUserTs = Date.now();

    const msg: RoomMessage = { from: senderId, to, role, content };
    await this.deliver(msg);
  }

  /** Broadcast to the whole room (default path when no explicit target). */
  async broadcast(senderId: string, content: string): Promise<void> {
    const role: Role = senderId === "User" ? "user" : "assistant";
    if (role === "user") this.lastUserTs = Date.now();
    const msg: RoomMessage = { from: senderId, to: "@group", role, content };
    await this.deliver(msg);
  }
}

export default ChatRoom;
