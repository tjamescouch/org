import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { AgentModel } from "../src/core/entity/agent-model";

// Minimal scripted model: emits the next string in `script` as an assistant message
function scriptedModel(script: string[]) {
  let i = 0;
  return {
    async chatOnce(_args: any) {
      const content = script[i++] ?? "";
      return { role: "assistant", content };
    },
  };
}

// Reproduces: after Alice’s first assistant turn, the scheduler must advance to Bob.
// If it doesn’t, Bob’s run counter will stay flat and the test will fail.
test("after Alice greets, Bob is scheduled (no stall after first turn)", async () => {
  const room = new ChatRoom();

  const alice = new AgentModel("alice"); (alice as any).model = scriptedModel(["Hi there — Alice."]);
  const bob   = new AgentModel("bob");   (bob   as any).model = scriptedModel(["Bob here."]);
  const carol = new AgentModel("carol"); (carol as any).model = scriptedModel(["Carol here."]);

  room.addModel(alice); room.addModel(bob); room.addModel(carol);

  const tm = new TurnManager(room, [alice, bob, carol], { tickMs: 20, proactiveMs: 40, idleBackoffMs: 0 });
  tm.start();

  // Seed the convo
  await room.broadcast("User", "Ello Guvna");

  const bobRuns0 = (bob as any).runs ?? 0;

  // Wait up to ~1.5s for Bob to get at least one turn
  const t0 = Date.now();
  while (((bob as any).runs ?? 0) <= bobRuns0 && Date.now() - t0 < 1500) {
    await new Promise(r => setTimeout(r, 25));
  }

  tm.stop();

  expect(((bob as any).runs ?? 0)).toBeGreaterThan(bobRuns0);
});

