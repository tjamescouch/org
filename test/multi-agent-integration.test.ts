// Robust multi-agent integration test: passes as soon as we see real chatter.
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/orchestration/chat-room"; // adjust if needed
import { Logger } from "../src/logger";                    // adjust if needed

function countAssistantMessages(history: Array<{role:string, content:string}>) {
  return history.filter(m => m.role === "assistant").length;
}

test("multi-agent integration with mock server", async () => {
  // Make sure we can see debug if LOG_LEVEL asks for it.
  Logger.info("[multi-agent] starting test");

  // Create a room with mock personas (your helper should already do this).
  const room = new ChatRoom({ personas: ["alice", "bob"], model: "mock" } as any);

  // Start the conversation.
  await room.sendUser("Hello agents");

  // Poll for back-and-forth: as soon as we see >= 2 assistant messages, PASS.
  const start = Date.now();
  const deadline = start + 8000;  // wait up to ~8s for chatter
  let lastCount = 0;

  while (Date.now() < deadline) {
    const h = room.history ?? [];
    const c = countAssistantMessages(h as any);
    if (c !== lastCount) {
      Logger.debug(`[multi-agent] assistant count = ${c}`);
      lastCount = c;
    }
    if (c >= 2) break;
    await new Promise(r => setTimeout(r, 400));
  }

  const finalHistory = room.history ?? [];
  const assistants = countAssistantMessages(finalHistory as any);
  Logger.info(`[multi-agent] final assistant count = ${assistants}`);
  if (assistants < 2) {
    // Show last few messages to help debug if it fails.
    const tail = finalHistory.slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");
    throw new Error(`expected at least 2 assistant messages, got ${assistants}\n--- tail ---\n${tail}`);
  }

  expect(assistants).toBeGreaterThanOrEqual(2);
}, 20000 /* overall test timeout */);
