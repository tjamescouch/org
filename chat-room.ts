// -------------------------------------------------------------------
// 4️⃣  ChatRoom – the hub that wires everything together

import type { ChatRole } from "./chat";
import type { RoomModel, SeqListener } from "./room-model";


export interface RoomMessage {
  ts: string;         // ISO timestamp set by the room
  from: string;       // sender model id (or "System")
  content: string;       // plain text payload
  recipient?: string; // optional direct recipient model id
  seq?: number;       // room sequence number (set by the room)
  role: ChatRole;     // role as seen by recipients
  read: boolean;      // delivery/read flag (room sets false)
}


// -------------------------------------------------------------------
export class ChatRoom {
  private models = new Map<string, RoomModel>();
  private seqCounter = 0;
  private listeners = new Set<SeqListener>();

  addModel(model: RoomModel): void {
    if (this.models.has(model.id)) throw new Error(`Model id already exists: ${model.id}`);
    this.models.set(model.id, model);
    model.onAttach?.(this);
  }

  removeModel(id: string): void {
    const m = this.models.get(id);
    if (!m) return;
    this.models.delete(id);
    m.onDetach?.(this);
  }

  getSeq(): number {
    return this.seqCounter;
  }

  onSeqChange(fn: SeqListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async broadcast(from: string, text: string | undefined | null): Promise<void> {
    const msg = this.makeMessage(from, text);
    this.bumpSeq(msg);
    await this.deliver(msg, undefined);
  }

  async sendTo(from: string, to: string, text: string | undefined | null): Promise<void> {
    const msg = this.makeMessage(from, text, to);
    this.bumpSeq(msg);
    await this.deliver(msg, to);
  }

  private makeMessage(from: string, text: string | undefined | null, recipient?: string): RoomMessage {
    const role: ChatRole = from === "System" ? "system" : "user";
    const safeText = (text ?? "").toString();
    return {
      ts: new Date().toISOString(),
      from,
      content: safeText,
      recipient,
      role,
      read: false,
      // seq set in bumpSeq()
    };
  }

  private bumpSeq(msg: RoomMessage): void {
    msg.seq = ++this.seqCounter;
    for (const fn of this.listeners) { try { fn(this.seqCounter); } catch {} }
  }

  private async deliver(msg: RoomMessage, directTo?: string): Promise<void> {
    if (directTo) {
      const target = this.models.get(directTo);
      if (target) {
        await this.safeDeliver(target, msg); // direct messages remain awaited
      }
      return;
    }

    // BROADCAST: fire-and-forget to avoid room stalls
    for (const [id, model] of this.models) {
      if (id === msg.from) continue; // no echo
      // intentionally do not await; each delivery is time-limited
      void this.safeDeliver(model, msg);
    }
  }

  // Deliver with a hard timeout so a single slow model can't jam the room.
  private async safeDeliver(model: RoomModel, msg: RoomMessage): Promise<void> {
    const TIMEOUT_MS = 30_000; // adjust as needed
    const t = setTimeout(() => {
      // optional: structured log here
      // console.warn(`[room] deliver timeout to ${model.id} on seq=${msg.seq}`);
    }, TIMEOUT_MS);

    try {
      await Promise.race([
        model.receiveMessage(msg),
        new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT_MS)),
      ]);
    } catch {
      // swallow model errors; they shouldn't crash the room
    } finally {
      clearTimeout(t);
    }
  }
}
