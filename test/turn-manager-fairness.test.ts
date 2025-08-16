
// test/turn-manager-fairness.test.ts
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

class LightAgent extends Model {
  inbox: any[] = [];
  delivered = 0;
  runs = 0;
  async receiveMessage(m: any) { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  onRoomMessage(m: any)        { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  enqueueFromRoom(m: any)      { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  hasUnread() { return this.inbox.length > 0; }
  async takeTurn() { if (!this.inbox.length) return false; this.inbox.shift(); this.runs++; return true; }
}

test("round-robin fairness: both agents get turns, no starvation", async () => {
  const room = new ChatRoom();
  const a = new LightAgent("A");
  const b = new LightAgent("B");

  (a as any).attachRoom?.(room);
  (b as any).attachRoom?.(room);

  room.addModel(a as any);
  room.addModel(b as any);

  const tm = new TurnManager(room, [a as any, b as any], { tickMs: 15, idleBackoffMs: 0, proactiveMs: 10_000 });
  (tm as any)._bindOnce?.();
  tm.start();

  await room.broadcast("User", "kick");

  const tDeliver = Date.now();
  while ((a.delivered < 1 || b.delivered < 1) && Date.now() - tDeliver < 1500) await sleep(25);

  await sleep(300);
  tm.stop();

  expect(a.runs).toBeGreaterThan(0);
  expect(b.runs).toBeGreaterThan(0);
  expect(Math.abs(a.runs - b.runs)).toBeLessThan(6);
}, 10000);
