import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { AgentModel } from "../src/core/entity/agent-model";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

test("watchdog fires during live ticks", async () => {
  const room = new ChatRoom();
  const a = new AgentModel("a","mock") as any;
  const inbox: any[] = [];
  a.enqueueFromRoom = (m: any) => { inbox.push(m); };
  room.addModel(a);

  await room.broadcast("User", "seed"); // prime 'recent activity'

  const tm = new TurnManager(room, [a], { tickMs: 25, idleBackoffMs: 0, pokeAfterMs: 120, proactiveMs: 10_000 });
  tm.start();

  let ok = false;
  for (let i = 0; i < 40; i++) {  // up to ~1s
    await sleep(25);
    if (inbox.some((m: any) => m?.content === "(resume)")) { ok = true; break; }
  }

  tm.stop();
  expect(ok).toBe(true);
});
