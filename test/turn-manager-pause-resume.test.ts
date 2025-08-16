
// test/turn-manager-pause-resume.test.ts
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

class CounterAgent extends Model {
  inbox: any[] = [];
  delivered = 0;
  count = 0;
  async receiveMessage(m: any) { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  onRoomMessage(m: any)        { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  enqueueFromRoom(m: any)      { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  hasUnread() { return this.inbox.length > 0; }
  async takeTurn() { if (!this.inbox.length) return false; this.inbox.shift(); this.count++; return true; }
}

test("pausing halts turns; resuming continues", async () => {
  const room = new ChatRoom();
  const a = new CounterAgent("A");

  (a as any).attachRoom?.(room);
  room.addModel(a as any);

  const tm = new TurnManager(room, [a as any], { tickMs: 20, idleBackoffMs: 0, proactiveMs: 99999 });
  (tm as any)._bindOnce?.();
  tm.start();

  await room.broadcast("User", "go");

  const tDeliver = Date.now();
  while (a.delivered < 1 && Date.now() - tDeliver < 1500) await sleep(25);

  const t0 = Date.now();
  while (a.count === 0 && Date.now() - t0 < 1500) await sleep(25);
  expect(a.count).toBeGreaterThan(0);

  tm.pause();
  const atPause = a.count;

  await room.broadcast("User", "extra");
  await sleep(250);
  expect(a.count).toBe(atPause);

  tm.resume();
  const t1 = Date.now();
  while (Date.now() - t1 < 600 && a.count === atPause) await sleep(25);

  tm.stop();
  expect(a.count).toBeGreaterThan(atPause);
}, 10000);
