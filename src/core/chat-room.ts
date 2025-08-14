// src/core/chat-room.ts
import type { ChatMessage } from "../types";
import type { Model } from "./entity/model";

export interface RoomMessage extends ChatMessage {}

export interface RoomAPI {
  sendTo(from: string, recipient: string, content: string): Promise<void>;
  broadcast(from: string, content: string): Promise<void>;
}

export class ChatRoom implements RoomAPI {
  private readonly models = new Map<string, Model>();

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
    await m.receiveMessage(msg);
  }

  async broadcast(from: string, content: string): Promise<void> {
    const msg: RoomMessage = { role: "user", from, content };
    await Promise.all([...this.models.values()].map(m => m.receiveMessage(msg)));
  }
}