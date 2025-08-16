import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";

class SilentAgent extends Model {
  inbox: any[] = [];
  queued: number = 0;
  async receiveMessage(m: any) { if (m.from !== this.id) { this.inbox.push(m); this.queued++; } }
  hasUnread() { return false; }               // never claims unread
  async takeTurn() { return false; }          // never runs
}

test("idle watchdog pokes agents with (resume)", async () => {
  const room = new ChatRoom();
  const a = new SilentAgent("a");
  room.addModel(a as any);

  // Prime with a real event so the idle timer has something to measure from
  await room.broadcast("User", "seed");

  const tm = new TurnManager(
    room,
    [a as any],
    { tickMs: 25, idleBackoffMs: 0, pokeAfterMs: 200, proactiveMs: 10_000 }
  );

  tm.start();
  await new Promise(r => setTimeout(r, 320)); // leave slack for timers
  tm.stop();

  // Expect: 'seed' + '(resume)' from the watchdog
  expect(a.queued).toBeGreaterThan(1);
});

