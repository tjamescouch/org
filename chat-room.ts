// chat-room.ts — canonical room types and implementation (uses `content` payload)

export type ChatRole = "system" | "user" | "assistant" | "tool";

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
  private paused = false;
  private pauseWaiters: Array<() => void> = [];

  pause() { this.paused = true; }
  resume() { this.paused = false; this.pauseWaiters.splice(0).forEach(fn => { try { fn(); } catch {} }); }

/**
 * Wait only when paused AND the message is not a human interject.
 * Human interjects use from === "User" and should pass through while paused.
 */
  private async waitIfPausedFor(msg: RoomMessage) {
    if (!this.paused) return;
    if ((msg.from || "").toLowerCase() === "user") return; // let interjects through
    await new Promise<void>(resolve => this.pauseWaiters.push(resolve));
  }

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


    // agent-model.ts (public surface)
  public hasUnread(): boolean { return this.inbox.length > 0; }

  // ChatRoom calls this instead of receiveMessage()
  public enqueueFromRoom(msg: RoomMessage) { this._enqueue(msg); }

  // TurnManager calls this to do one atomic turn (drain → decide → chatOnce/tools → deliver)
  public async takeTurn(): Promise<boolean> {
    // short-circuit: if user currently typing / pause flag set, do nothing
    if ((globalThis as any).__PAUSE_INPUT) return false;

    const unread = this._drainUnread();        // batch all unread
    if (unread.length === 0) return false;     // nothing to do

    // Build history (system + summary + tail + unread), then run your existing runWithTools(...)
    const messages = this._buildHistory(unread);
    const tools    = [ this._defShellTool() ];
    const replies  = await this.runWithTools(messages, tools, (c)=>this._execTool(c), 25);

    // Deliver final user-visible message (your existing _deliver)
    const last = replies[replies.length - 1];
    if (last?.content) await this._deliver(last.content);

    // Update SoC, context, summarization, etc. (you already have these)
    this._appendSoC(/*...*/);
    this.cleanContext();

    return true;
  }

  /** Optional: allow the manager to kill the current turn if the watchdog fires */
  public abortCurrentTurn?(reason: string): void {
    try { require("./chat").interruptChat(); } catch {}
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
    const TIMEOUT_MS = 120_000; // 2 minutes hard cap per recipient
    await new Promise<void>(async (resolve) => {
      const t = setTimeout(() => {
        // Timeout fires – resolve and drop this delivery without blocking others.
        resolve();
      }, TIMEOUT_MS);
      try {
        await this.waitIfPausedFor(msg);
        await model.receiveMessage(msg);
      } catch {
        // swallow model errors to avoid crashing the room
      } finally {
        clearTimeout(t);
        resolve();
      }
    });
  }
}