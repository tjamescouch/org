// test/turn-manager-pause-resume.test.ts
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

class CounterAgent extends Model {
  inbox: any[] = [];
  count = 0;
  async receiveMessage(m: any) { if (m?.from !== this.id) this.inbox.push(m); }
  hasUnread() { return this.inbox.length > 0; }
  async takeTurn() { this.inbox.shift(); this.count++; return true; }
}

test("pausing halts turns; resuming continues", async () => {
  const room = new ChatRoom();
  const a = new CounterAgent("a");
  room.addModel(a as any);

  const tm = new TurnManager(room, [a as any], { tickMs: 20, idleBackoffMs: 0, proactiveMs: 99999 });
  tm.start();

  await room.broadcast("User", "go");
  await sleep(120);
  expect(a.count).toBeGreaterThan(0);

  tm.pause();
  const atPause = a.count;
  await room.broadcast("User", "extra"); // even with unread, should not run while paused
  await sleep(200);
  expect(a.count).toBe(atPause);

  tm.resume();
  const t0 = Date.now();
  while (Date.now() - t0 < 400 && a.count === atPause) {
    await sleep(20);
  }
  tm.stop();
  expect(a.count).toBeGreaterThan(atPause);
});
