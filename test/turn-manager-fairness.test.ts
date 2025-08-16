// test/turn-manager-fairness.test.ts
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

class LightAgent extends Model {
  inbox: any[] = [];
  runs = 0;
  async receiveMessage(m: any) { if (m?.from !== this.id) this.inbox.push(m); }
  hasUnread() { return this.inbox.length > 0; }
  async takeTurn() { this.inbox.shift(); this.runs++; return true; }
}

test("round-robin fairness: both agents get turns, no starvation", async () => {
  const room = new ChatRoom();
  const a = new LightAgent("A");
  const b = new LightAgent("B");
  room.addModel(a as any);
  room.addModel(b as any);

  const tm = new TurnManager(room, [a as any, b as any], { tickMs: 15, idleBackoffMs: 0, proactiveMs: 10_000 });
  tm.start();

  // Prime both with messages
  await room.broadcast("User", "kick");
  await sleep(300);
  tm.stop();

  expect(a.runs).toBeGreaterThan(0);
  expect(b.runs).toBeGreaterThan(0);
  // Ensure no wild imbalance (tolerate small skew)
  expect(Math.abs(a.runs - b.runs)).toBeLessThan(5);
});
