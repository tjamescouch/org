// src/core/chat-room.ts
import type { ChatMessage } from "../types";
import type { Model } from "./entity/model";

export interface RoomMessage extends ChatMessage {}

export interface RoomAPI {
  sendTo(from: string, recipient: string, content: string): Promise<void>;
  broadcast(from: string, content: string): Promise<void>;
  /**
   * Returns true for a short window after a user message is sent.  The
   * TurnManager uses this to schedule turns aggressively after user input.
   */
  hasFreshUserMessage(): boolean;
}

export class ChatRoom implements RoomAPI {
  private readonly models = new Map<string, Model>();

  // Timestamp of the last user-originating message (ms since epoch)
  private lastUserTs = 0;

  addModel(model: Model) {
    if (this.models.has(model.id)) throw new Error(`Model id already in room: ${model.id}`);
    this.models.set(model.id, model);
    (model as any).onAttach?.(this);
  }

  removeModel(id: string) {
    const m = this.models.get(id);
    if (!m) return;
    this.models.delete(id);
    (m as any).onDetach?.();
  }

  async sendTo(from: string, recipient: string, content: string): Promise<void> {
    const m = this.models.get(recipient);
    if (!m) return;
    const msg: RoomMessage = { role: "user", from, to: recipient, content };
    // Always update the freshness timestamp on any message.  The turn
    // manager uses this to schedule a burst of replies immediately
    // following user or agent messages.
    this.lastUserTs = Date.now();
    await m.receiveMessage(msg);
  }

  async broadcast(from: string, content: string): Promise<void> {
    const msg: RoomMessage = { role: "user", from, content };
    // Update the freshness timestamp unconditionally.  A broadcast from
    // any sender indicates new activity and should trigger the
    // scheduler to prioritize agents.
    this.lastUserTs = Date.now();
    await Promise.all([...this.models.values()].map(m => m.receiveMessage(msg)));
  }

  /**
   * Indicate whether a user message has been received recently.  The default
   * freshness window is ~2 seconds, matching the expectation of TurnManager.
   */
  hasFreshUserMessage(): boolean {
    return Date.now() - this.lastUserTs < 2000;
  }
}