// After hardening tick(): even if transport is busy forever, the idle poke must fire.
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { AgentModel } from "../src/core/entity/agent-model";

(globalThis as any).__transport = { cap: 1, inflight: () => 1, cooling: () => false };

test("when transport is stuck busy, idle poke still happens", async () => {
  const room = new ChatRoom();
  const a = new AgentModel("a","mock") as any;
  let poked = 0;
  a.enqueueFromRoom = (m: any) => { if (m?.content === "(resume)") poked++; };
  room.addModel(a);

  const tm = new TurnManager(room, [a], { tickMs: 25, pokeAfterMs: 200, proactiveMs: 999999 });
  tm.start();
  await new Promise(r => setTimeout(r, 260));
  tm.stop();

  expect(poked).toBeGreaterThan(0);
});
