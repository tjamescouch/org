import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

class SilentAgent extends Model {
  inbox: any[] = [];
  async receiveMessage(m: any) { if (m.from !== this.id) this.inbox.push(m); }
  hasUnread() { return false; }   // never claims unread
  async takeTurn() { return false; } // never runs
}

test("idle watchdog pokes agents with (resume)", async () => {
  const room = new ChatRoom();
  const a = new SilentAgent("a");
  room.addModel(a as any);

  // Prime the system so the idle timer has a reference point
  await room.broadcast("User", "seed");

  const tm = new TurnManager(
    room,
    [a as any],
    { tickMs: 25, idleBackoffMs: 0, pokeAfterMs: 200, proactiveMs: 10_000 }
  );
  tm.start();

  // Poll (up to ~1s) for a watchdog "(resume)" message; avoid brittle exact counts
  let sawResume = false;
  for (let i = 0; i < 20; i++) {
    await sleep(50);
    if (a.inbox.some((m: any) => m?.content === "(resume)")) {
      sawResume = true;
      break;
    }
  }

  tm.stop();
  expect(sawResume).toBe(true);
});
