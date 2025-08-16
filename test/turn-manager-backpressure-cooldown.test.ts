import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";

class CounterAgent extends Model {
  inbox: any[] = [];
  runs = 0;
  async receiveMessage(m: any) { if (m.from !== this.id) this.inbox.push(m); }
  hasUnread() { return this.inbox.length > 0; }
  async takeTurn() { this.inbox.shift(); this.runs++; return true; }
}

test("scheduler pauses during cooling then runs", async () => {
  const start = Date.now();
  (globalThis as any).__transport = {
    cap: 1,
    inflight: () => 0,
    cooling: () => Date.now() - start < 120
  };

  const room = new ChatRoom();
  const a = new CounterAgent("a");
  room.addModel(a as any);
  await room.broadcast("User", "go");

  const tm = new TurnManager(room, [a as any], { tickMs: 25, idleBackoffMs: 0, proactiveMs: 1_000 });
  tm.start();

  await new Promise(r => setTimeout(r, 80));
  expect(a.runs).toBe(0);

  await new Promise(r => setTimeout(r, 120));
  tm.stop();
  expect(a.runs).toBeGreaterThan(0);
});
