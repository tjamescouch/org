import type { RoomAPI, RoomMessage } from "../chat-room";

export abstract class Model {
  public readonly id: string;
  protected room?: RoomAPI;

  constructor(id: string) { this.id = id; }

  onAttach(room: RoomAPI): void { this.room = room; }
  onDetach(): void { this.room = undefined; }

  abstract receiveMessage(msg: RoomMessage): Promise<void>;

  public async broadcast(content: string, recipient?: string): Promise<void> {
    if (!this.room) throw new Error(`Model "${this.id}" is not attached to a ChatRoom`);
    if (recipient) await this.room.sendTo(this.id, recipient, content);
    else await this.room.broadcast(this.id, content);
  }

  public async sendTo(recipient: string, content: string): Promise<void> {
    if (!this.room) throw new Error(`Model "${this.id}" is not attached to a ChatRoom`);
    await this.room.sendTo(this.id, recipient, content);
  }
}