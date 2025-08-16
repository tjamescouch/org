import { ChatRoom } from "../src/core/chat-room";
import { TurnManager } from "../src/core/turn-manager";
import { AgentModel } from "../src/core/entity/agent-model";

function scriptedModel(script: string[]) {
  let i = 0;
  return {
    async chatOnce(_args: any) {
      const content = script[i++] ?? "";
      // No @targets on purpose: this must route to group by default.
      return { role: "assistant", content };
    },
  };
}

test("messages without an explicit target route to @group by default", async () => {
  const room = new ChatRoom();

  const alice = new AgentModel("alice"); (alice as any).model = scriptedModel(["Alice says hello."]);
  const bob   = new AgentModel("bob");   (bob   as any).model = scriptedModel(["Bob ack."]);
  const carol = new AgentModel("carol"); (carol as any).model = scriptedModel(["Carol ack."]);

  room.addModel(alice); room.addModel(bob); room.addModel(carol);

  const tm = new TurnManager(room, [alice, bob, carol], { tickMs: 20, proactiveMs: 40, idleBackoffMs: 0 });
  tm.start();

  // Initial user broadcast causes 1 delivery to each agent. Capture that baseline.
  await room.broadcast("User", "Kickoff");
  const baseB = (bob as any).delivered ?? 0;
  const baseC = (carol as any).delivered ?? 0;

  // Let Alice take a turn and emit her assistant message with no @target (should be @group)
  const t0 = Date.now();
  while ((((bob as any).delivered ?? 0) <= baseB || ((carol as any).delivered ?? 0) <= baseC)
         && Date.now() - t0 < 1500) {
    await new Promise(r => setTimeout(r, 25));
  }

  tm.stop();

  // Both Bob and Carol must have received Alice’s group message
  expect(((bob as any).delivered ?? 0)).toBeGreaterThan(baseB);
  expect(((carol as any).delivered ?? 0)).toBeGreaterThan(baseC);
});

