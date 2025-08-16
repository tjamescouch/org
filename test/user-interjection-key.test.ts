// test/user-interjection-key.test.ts
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { Model } from "../src/core/entity/model";
import { Logger } from "../src/ui/logger";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Minimal agent with the exact surface ChatRoom/TurnManager expect. */
class InstrumentedAgent extends Model {
  inbox: any[] = [];
  turns = 0;
  delivered = 0;

  async receiveMessage(m: any) { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  onRoomMessage(m: any)        { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }
  enqueueFromRoom(m: any)      { if (m?.from !== this.id) { this.inbox.push(m); this.delivered++; } }

  hasUnread() { return this.inbox.length > 0; }
  async takeTurn() {
    if (!this.inbox.length) return false;
    this.inbox.shift();
    this.turns++;
    return true;
  }
}

test("keypress 'i' triggers interjection (pauses scheduling)", async () => {
  const room = new ChatRoom();
  const agent = new InstrumentedAgent("A");
  room.addModel(agent as any);

  // Fast cadence; disable proactives to avoid noise
  const tm = new TurnManager(room, [agent as any], { tickMs: 15, idleBackoffMs: 0, proactiveMs: 10_000 });
  tm.start();

  // Prime: user says something to make the agent eligible
  await room.broadcast("User", "go");

  // Precondition: we should observe at least one turn before we test interjection
  const t0 = Date.now();
  while (agent.turns === 0 && Date.now() - t0 < 2000) await sleep(20);
  if (agent.turns === 0) {
    tm.stop();
    throw new Error("precondition failed: no turns occurred after kickoff (delivery path broken)");
  }
  const before = agent.turns;

  // Simulate the interjection key: user types a single "i"
  // Contract we are codifying: "i" should pause the scheduler.
  await room.broadcast("User", "i");

  // Give the scheduler a moment; turns should NOT advance while paused
  await sleep(300);
  const during = agent.turns;
  Logger.debug?.(`[interject 'i'] turns before=${before} during=${during}`);
  expect(during).toBe(before);

  // Resume and prove turns advance again (sanity)
  tm.resume();
  const t1 = Date.now();
  while (Date.now() - t1 < 500 && agent.turns === during) await sleep(20);

  tm.stop();
  expect(agent.turns).toBeGreaterThan(during);
}, 12000);
