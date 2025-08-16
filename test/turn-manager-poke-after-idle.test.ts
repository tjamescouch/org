import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { AgentModel } from "../src/core/entity/agent-model";

test("pokeIfIdle enqueues (resume) deterministically", async () => {
  const room = new ChatRoom();
  const a = new AgentModel("a","mock") as any;
  const inbox: any[] = [];
  a.enqueueFromRoom = (m: any) => { inbox.push(m); };
  room.addModel(a);

  const tm = new TurnManager(room, [a], { pokeAfterMs: 200 });
  (tm as any).lastAnyWorkTs = Date.now() - 1_000;

  // Call the method directly – no timers, no polling.
  (tm as any).__pokeIfIdle();

  expect(inbox.some((m: any) => m?.content === "(resume)")).toBe(true);
});
