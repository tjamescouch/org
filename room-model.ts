export interface RoomMessage {
  ts: string;         // ISO timestamp set by the room
  from: string;       // sender model id (or "System")
  text: string;       // plain text payload
  recipient?: string; // optional direct recipient model id
  seq?: number;       // room sequence number (set by the room)
}

export interface RoomModel {
  id: string;
  receiveMessage(msg: RoomMessage): Promise<void>;
  onAttach?(room: RoomAPI): void;  // <- use RoomAPI
  onDetach?(room: RoomAPI): void;  // <- use RoomAPI
}

export interface RoomAPI {
  getSeq(): number;
  onSeqChange(fn: (seq: number) => void): () => void;
  broadcast(from: string, text: string): Promise<void>;
  sendTo(from: string, to: string, text: string): Promise<void>;
}

// Minimal shape the Room expects from a Model.
// Your concrete Model class should implement these.
export interface RoomModel {
  id: string;
  // Called when a message is delivered to this model.
  receiveMessage(msg: RoomMessage): Promise<void>;
  // Called once when the model is added to the room (optional).
  onAttach?(room: ChatRoom): void;
  // Called on removal (optional).
  onDetach?(room: ChatRoom): void;
}

export type SeqListener = (seq: number) => void;

export class ChatRoom {
  private models = new Map<string, RoomModel>();
  private seqCounter = 0;
  private listeners = new Set<SeqListener>();

  /** Register a model with the room. */
  addModel(model: RoomModel): void {
    if (this.models.has(model.id)) {
      throw new Error(`Model id already exists in room: ${model.id}`);
    }
    this.models.set(model.id, model);
    model.onAttach?.(this);
  }

  /** Remove a model from the room. */
  removeModel(id: string): void {
    const m = this.models.get(id);
    if (!m) return;
    this.models.delete(id);
    m.onDetach?.(this);
  }

  /** Current global sequence value. Monotonic, starts at 0. */
  getSeq(): number {
    return this.seqCounter;
  }

  /**
   * Subscribe to sequence changes (used by agents to preempt stale turns).
   * Returns an unsubscribe function.
   */
  onSeqChange(fn: SeqListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Broadcast a message to all models except the sender. */
  async broadcast(from: string, text: string): Promise<void> {
    const msg = this.makeMessage(from, text);
    this.bumpSeq(msg);
    await this.deliver(msg, /*directTo*/ undefined);
  }

  /** Send a direct message to a specific model id. */
  async sendTo(from: string, to: string, text: string): Promise<void> {
    const msg = this.makeMessage(from, text, to);
    this.bumpSeq(msg);
    await this.deliver(msg, to);
  }

  /** Internal: create a RoomMessage with ts (and optional recipient). */
  private makeMessage(from: string, text: string, recipient?: string): RoomMessage {
    return {
      ts: new Date().toISOString(),
      from,
      text,
      recipient,
      // seq is assigned in bumpSeq()
    };
  }

  /** Internal: increment global seq, stamp message, and notify listeners. */
  private bumpSeq(msg: RoomMessage): void {
    msg.seq = ++this.seqCounter;
    // Notify subscribers so agents can abort stale work immediately.
    for (const fn of this.listeners) {
      try { fn(this.seqCounter); } catch { /* ignore listener errors */ }
    }
  }

  /** Internal: deliver message to intended recipients. */
  private async deliver(msg: RoomMessage, directTo?: string): Promise<void> {
    if (directTo) {
      const target = this.models.get(directTo);
      if (!target) return;
      await this.safeDeliver(target, msg);
      return;
    }

    // Broadcast to everyone except sender.
    for (const [id, model] of this.models) {
      if (id === msg.from) continue;
      await this.safeDeliver(model, msg);
    }
  }

  /** Wrap model.receiveMessage to avoid one bad model breaking the room loop. */
  private async safeDeliver(model: RoomModel, msg: RoomMessage): Promise<void> {
    try {
      await model.receiveMessage(msg);
    } catch (err) {
      // You may want to log this somewhere central.
      // console.error(`[room] deliver to ${model.id} failed:`, err);
    }
  }
}