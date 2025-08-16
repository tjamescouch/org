import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";

function installTransportGate() {
  const state = { in: 0, coolUntil: 0, q: [] as Array<() => void> };
  (globalThis as any).__transport = {
    cap: 1,
    inflight() { return state.in; },
    cooling()  { return Date.now() < state.coolUntil; },
    async acquire() {
      if (state.in === 0) {
        state.in = 1;
        return async () => { state.in = 0; state.coolUntil = Date.now() + 120; const n = state.q.shift(); n?.(); };
      }
      await new Promise<void>(res => state.q.push(res));
      state.in = 1;
      return async () => { state.in = 0; state.coolUntil = Date.now() + 120; const n = state.q.shift(); n?.(); };
    },
  };
}

class ToolHoldingAgent extends Model {
  inbox: any[] = []; sent = 0;
  async receiveMessage(m: any) { if (m.from !== this.id) this.inbox.push(m); }
  hasUnread() { return this.inbox.length > 0; }
  async takeTurn() {
    if (!this.inbox.length) return false;
    this.inbox.shift();
    const rel = await (globalThis as any).__transport.acquire("sh");
    await new Promise(r => setTimeout(r, 120));
    await rel();
    await this.broadcast("alice-done");
    this.sent++;
    return true;
  }
}

class PassiveAgent extends Model {
  inbox: any[] = []; received = 0;
  async receiveMessage(m: any) { if (m.from !== this.id) this.inbox.push(m); }
  hasUnread() { return this.inbox.length > 0; }
  async takeTurn() {
    if (!this.inbox.length) return false;
    this.inbox.shift();
    this.received++;
    return true;
  }
}

test("after Alice finishes a tool call, Bob gets scheduled (no starvation)", async () => {
  installTransportGate();

  const room = new ChatRoom();
  const alice = new ToolHoldingAgent("Alice");
  const bob   = new PassiveAgent("Bob");
  room.addModel(alice as any);
  room.addModel(bob as any);

  await room.broadcast("User", "kickoff");

  const tm = new TurnManager(room, [alice as any, bob as any], { tickMs: 30, idleBackoffMs: 10, proactiveMs: 500 });
  tm.start();
  await new Promise(r => setTimeout(r, 600));
  tm.stop();

  expect(alice.sent).toBeGreaterThan(0);
  expect(bob.received).toBeGreaterThan(0);
});
