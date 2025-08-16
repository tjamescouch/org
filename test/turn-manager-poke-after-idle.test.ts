import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";

class SilentAgent extends Model {
  inbox: any[] = [];
  queued: number = 0;
  async receiveMessage(m: any) { if (m.from !== this.id) { this.inbox.push(m); this.queued++; } }
  hasUnread() { return false; }
  async takeTurn() { return false; }
}

test("idle watchdog pokes agents with (resume)", async () => {
  const room = new ChatRoom();
  const a = new SilentAgent("a");
  room.addModel(a as any);

  // Prime with a real event so the idle timer has a reference point
  await room.broadcast("User", "seed");

  const tm = new TurnManager(room, [a as any], { tickMs: 25, idleBackoffMs: 0, pokeAfterMs: 200, proactiveMs: 10_000 });
  tm.start();
  await new Promise(r => setTimeout(r, 320));
  tm.stop();

  // Expect: 'seed' + at least one '(resume)' from the watchdog
  expect(a.queued).toBeGreaterThan(1);
});
