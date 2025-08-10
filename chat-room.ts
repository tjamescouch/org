// chat-room.ts — canonical room types and implementation (uses `content` payload)

export type ChatRole = "system" | "user" | "assistant";

export interface RoomMessage {
  ts: string;         // ISO timestamp
  from: string;       // sender id (or "System")
  content: string;    // payload text
  recipient?: string; // direct recipient id
  seq?: number;       // room sequence
  role: ChatRole;     // role as seen by recipients
  read: boolean;      // delivery flag
}

export type SeqListener = (seq: number) => void;

export interface RoomAPI {
  getSeq(): number;
  onSeqChange(fn: SeqListener): () => void;
  broadcast(from: string, content: string | undefined | null): Promise<void>;
  sendTo(from: string, to: string, content: string | undefined | null): Promise<void>;
}

export interface RoomModel {
  id: string;
  receiveMessage(msg: RoomMessage): Promise<void>;
  onAttach?(room: RoomAPI): void;
  onDetach?(room: RoomAPI): void;
}

export class ChatRoom implements RoomAPI {
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

  getSeq(): number { return this.seqCounter; }

  onSeqChange(fn: SeqListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async broadcast(from: string, content: string | undefined | null): Promise<void> {
    const msg = this.makeMessage(from, content);
    this.bumpSeq(msg);
    await this.deliver(msg, undefined);
  }

  async sendTo(from: string, to: string, content: string | undefined | null): Promise<void> {
    const msg = this.makeMessage(from, content, to);
    this.bumpSeq(msg);
    await this.deliver(msg, to);
  }

  private makeMessage(from: string, content: string | undefined | null, recipient?: string): RoomMessage {
    const role: ChatRole = from === "System" ? "system" : "user";
    const safe = (content ?? "").toString();
    return {
      ts: new Date().toISOString(),
      from,
      content: safe,
      recipient,
      role,
      read: false,
    };
  }

  private bumpSeq(msg: RoomMessage): void {
    msg.seq = ++this.seqCounter;
    for (const fn of this.listeners) { try { fn(this.seqCounter); } catch {} }
  }

  private async deliver(msg: RoomMessage, directTo?: string): Promise<void> {
    if (directTo) {
      const target = this.models.get(directTo);
      if (target) await this.safeDeliver(target, msg);
      return;
    }
    // fire-and-forget broadcast to avoid stalls
    for (const [id, model] of this.models) {
      if (id === msg.from) continue;
      void this.safeDeliver(model, msg);
    }
  }

  private async safeDeliver(model: RoomModel, msg: RoomMessage): Promise<void> {
    const TIMEOUT_MS = 30_000;
    try {
      await Promise.race([
        model.receiveMessage(msg),
        new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT_MS)),
      ]);
    } catch {
      // swallow
    }
  }
}