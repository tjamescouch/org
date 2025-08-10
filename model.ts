// model.ts
import type { RoomMessage } from "./chat-room";
import type { RoomAPI } from "./room-model";

export abstract class Model {
  public readonly id: string;
  protected room?: RoomAPI;

  constructor(id: string) {
    this.id = id;
  }

  // Room will call this when added
  onAttach(room: RoomAPI): void {
    this.room = room;
  }

  // Room will call this when removed
  onDetach(): void {
    this.room = undefined;
  }

  abstract receiveMessage(msg: RoomMessage): Promise<void>;

  /** Helper: broadcast or direct-send via the room */
  public async broadcast(text: string, recipient?: string): Promise<void> {
    if (!this.room) throw new Error(`Model "${this.id}" is not attached to a ChatRoom`);
    if (recipient) {
      await this.room.sendTo(this.id, recipient?.replace(/\@agent:/, "") ?? '', text);
    } else {
      await this.room.broadcast(this.id, text);
    }
  }

  /** Convenience for direct send */
  public async sendTo(recipient: string, text: string): Promise<void> {
    if (!this.room) throw new Error(`Model "${this.id}" is not attached to a ChatRoom`);
    await this.room.sendTo(this.id, recipient, text);
  }
}
