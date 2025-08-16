import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { AgentModel } from "../src/core/entity/agent-model";
import { sleep } from "./helpers/sleep";

test("watchdog fires during live ticks", async () => {
  const room = new ChatRoom();
  const a = new AgentModel("a","mock") as any;
  const inbox: any[] = [];
  a.enqueueFromRoom = (m: any) => { inbox.push(m); };
  room.addModel(a);

  // Make us look idle *before* starting the loop (deterministic trigger)
  const tm = new TurnManager(room, [a], { tickMs: 20, idleBackoffMs: 0, pokeAfterMs: 100, proactiveMs: 10_000 });
  (tm as any).lastAnyWorkTs = Date.now() - 60_000;

  tm.start();

  let ok = false;
  for (let i = 0; i < 50; i++) { // up to ~1s
    await sleep(20);
    if (inbox.some((m: any) => m?.content === "(resume)")) { ok = true; break; }
  }

  tm.stop();
  expect(ok).toBe(true);
});
