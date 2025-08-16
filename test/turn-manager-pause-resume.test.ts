import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";
import { Logger } from "../src/ui/logger";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Minimal agent with the exact surface ChatRoom/TurnManager expect. */
class InstrumentedAgent extends Model {
  inbox: any[] = [];
  count = 0;          // turns taken
  delivered = 0;      // messages delivered into inbox

  async receiveMessage(m: any) { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  onRoomMessage(m: any)        { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  enqueueFromRoom(m: any)      { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }

  hasUnread() { return this.inbox.length > 0; }

  async takeTurn() {
    if (!this.inbox.length) return false;
    this.inbox.shift();
    this.count++;
    return true;
  }
}

test("pausing halts turns; resuming continues", async () => {
  const room = new ChatRoom();

  // Tap broadcast for debugging visibility if this ever flakes on CI
  const origBroadcast = (room as any).broadcast.bind(room);
  (room as any).broadcast = async (from: string, content: string, directTo?: string) => {
    Logger.debug?.(`[pause-resume] broadcast from=${from} to=${directTo ?? "@group"} content=${JSON.stringify(content)}`);
    return origBroadcast(from, content, directTo);
  };

  const a = new InstrumentedAgent("A");
  room.addModel(a as any);

  const tm = new TurnManager(room, [a as any], { tickMs: 20, idleBackoffMs: 0, proactiveMs: 999999 });
  tm.start();

  await room.broadcast("User", "go");

  // Wait until the kickoff actually reaches the agent (diagnostic if it doesn't)
  const t0 = Date.now();
  while (a.delivered < 1 && Date.now() - t0 < 2000) await sleep(25);
  Logger.debug?.(`[pause-resume] delivered=${a.delivered}, turns=${a.count}`);

  // Give the scheduler a little time to run a turn
  await sleep(200);
  expect(a.count).toBeGreaterThan(0);

  tm.pause();
  const atPause = a.count;

  await room.broadcast("User", "extra");
  await sleep(250);
  expect(a.count).toBe(atPause); // no turns while paused

  tm.resume();
  const t1 = Date.now();
  while (Date.now() - t1 < 400 && a.count === atPause) await sleep(20);

  tm.stop();
  expect(a.count).toBeGreaterThan(atPause);
}, 10000);