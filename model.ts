// -------------------------------------------------------------------
// 1️⃣  Types used by the room

import { ChatRoom } from "./chat-room";
import type { RoomMessage } from "./chat-room";

// -------------------------------------------------------------------
type Timestamp = string; // ISO string, e.g. "2025-08-06T12:34:56.789Z"

// -------------------------------------------------------------------
// 2️⃣  Base Model (renamed from ChatContext)
// -------------------------------------------------------------------
export abstract class Model {
  /** Human‑readable identifier – used in the room history */
  readonly id: string;

  /** The room this model belongs to – set by ChatRoom.addModel */
  protected room?: ChatRoom;

  constructor(id: string) {
    this.id = id;
  }

  /** Called by ChatRoom when a new message arrives */
  abstract receiveMessage(msg: RoomMessage): Promise<void>;

  /** Helper that lets a model *broadcast* a message to the room */
  public async broadcast(text: string, recipient?: string): Promise<void> {
    if (!this.room) {
      throw new Error(`Model "${this.id}" is not attached to a ChatRoom`);
    }

    if (text) {
      await this.room.broadcast(this, text, recipient?.replace(/\@agent:/, "") ?? '');
    } else {
      console.warn(`${text} produced no output`);
    }
  }
}


