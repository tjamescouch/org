import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";
import { Logger } from "../src/ui/logger";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

class InstrumentedAgent extends Model {
  inbox: any[] = [];
  runs = 0;
  delivered = 0;

  async receiveMessage(m: any) { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  onRoomMessage(m: any)        { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  enqueueFromRoom(m: any)      { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }

  hasUnread() { return this.inbox.length > 0; }
  async takeTurn() { if (!this.inbox.length) return false; this.inbox.shift(); this.runs++; return true; }
}

test("round-robin fairness: both agents get turns, no starvation", async () => {
  const room = new ChatRoom();
  const a = new InstrumentedAgent("A");
  const b = new InstrumentedAgent("B");
  room.addModel(a as any);
  room.addModel(b as any);

  const tm = new TurnManager(room, [a as any, b as any], { tickMs: 15, idleBackoffMs: 0, proactiveMs: 10_000 });
  tm.start();

  await room.broadcast("User", "kick");

  // Wait until both agents actually received the kickoff (good diagnostics if not)
  const t0 = Date.now();
  while ((a.delivered < 1 || b.delivered < 1) && Date.now() - t0 < 2000) await sleep(25);
  Logger.debug?.(`[fairness] delivered A=${a.delivered} B=${b.delivered}`);

  await sleep(300);
  tm.stop();

  expect(a.runs).toBeGreaterThan(0);
  expect(b.runs).toBeGreaterThan(0);
  // No wild imbalance; allow a small skew
  expect(Math.abs(a.runs - b.runs)).toBeLessThan(6);
}, 10000);