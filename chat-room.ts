// -------------------------------------------------------------------
// 4️⃣  ChatRoom – the hub that wires everything together

import type { ChatRole } from "./chat";
import { Model } from "./model";


export interface RoomMessage {
  role: ChatRole;
  ts: string;          // when the message was created
  from: string;           // model.id that sent it
  to?: string;
  content: string;           // raw message content
  read: boolean;
}


// -------------------------------------------------------------------
export class ChatRoom {
  /** All participants */
  private readonly models: Model[] = [];

  /** Full room history (timestamped) */
  private readonly history: RoomMessage[] = [];

  /** Add a new participant – the model gets a back‑reference to this room */
  addModel(model: Model): void {
    if (this.models.some((m) => m.id === model.id)) {
      throw new Error(`A model with id "${model.id}" already exists in the room`);
    }
    // @ts-ignore – we know the property exists on Model
    model.room = this;
    this.models.push(model);
  }

  /** Return a shallow copy of the conversation log */
  getLog(): readonly RoomMessage[] {
    return [...this.history];
  }

  /** Internal method used by Model.broadcast */
  async broadcast(sender: Model, content: string, recipient: string): Promise<void> {
    const ts = new Date().toISOString();
    const msg: RoomMessage = { role: 'user', ts, from: sender.id, content, read: false, ...((recipient || undefined) && {to: recipient}) };

    // 1️⃣  Store in the room history
    this.history.push(msg);

    // 2️⃣  Deliver the message to every *other*
    for (const m of this.models) {
      if (m===sender) continue;
      if (recipient && m.id !== recipient) continue;
      
      void m.receiveMessage(msg).catch(e => console.error('receiveMessage error', e));

      //await new Promise((r) => setTimeout(r, 100)); //in case of infinite looping
    }
  }
}
