
// test/user-interjection-key.test.ts
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

class InstrumentedAgent extends Model {
  inbox: any[] = [];
  turns = 0; delivered = 0;
  async receiveMessage(m: any) { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  onRoomMessage(m: any)        { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  enqueueFromRoom(m: any)      { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  hasUnread() { return this.inbox.length > 0; }
  async takeTurn() { if (!this.inbox.length) return false; this.inbox.shift(); this.turns++; return true; }
}

test("keypress 'i' triggers interjection (pauses scheduling)", async () => {
  const room = new ChatRoom();
  const a = new InstrumentedAgent("A");
  (a as any).attachRoom?.(room);
  room.addModel(a as any);

  const tm = new TurnManager(room, [a as any], { tickMs: 15, idleBackoffMs: 0, proactiveMs: 10_000 });
  (tm as any)._bindOnce?.();
  tm.start();

  await room.broadcast("User", "go");

  const tDeliver = Date.now();
  while (a.delivered < 1 && Date.now() - tDeliver < 1500) await sleep(20);

  const t0 = Date.now();
  while (a.turns === 0 && Date.now() - t0 < 1500) await sleep(20);
  if (a.turns === 0) { tm.stop(); throw new Error("precondition failed: no turns after kickoff"); }
  const before = a.turns;

  await room.broadcast("User", "i"); // interjection key
  await sleep(300);
  const during = a.turns;
  expect(during).toBe(before);

  tm.resume();
  const t1 = Date.now();
  while (Date.now() - t1 < 500 && a.turns === during) await sleep(20);

  tm.stop();
  expect(a.turns).toBeGreaterThan(during);
}, 12000);
