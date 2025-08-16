import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { AgentModel } from "../src/core/entity/agent-model";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

test("watchdog still fires during prolonged busy transport", async () => {
  // Simulate a transport permanently stuck busy
  (globalThis as any).__transport = { cap: 1, inflight: () => 1, cooling: () => false };

  const room = new ChatRoom();
  const a = new AgentModel("a","mock") as any;
  const inbox: any[] = [];
  a.enqueueFromRoom = (m: any) => { inbox.push(m); };
  room.addModel(a);

  const tm = new TurnManager(room, [a], { tickMs: 25, idleBackoffMs: 0, pokeAfterMs: 200, proactiveMs: 999999 });
  tm.start();

  let sawResume = false;
  for (let i = 0; i < 30; i++) {
    await sleep(50);
    sawResume = inbox.some((m: any) => m?.content === "(resume)");
    if (sawResume) break;
  }

  tm.stop();
  expect(sawResume).toBe(true);
});
