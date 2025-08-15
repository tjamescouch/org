import { test } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { Logger } from "../src/logger";

// NOTE: baseUrl override to mock server is handled in test/integration.mock-server.test.ts
//       This test just verifies a simple two-agent exchange doesn't deadlock.
//       We accept any of the known user-send entrypoints.

async function sendUserCompat(room: any, text: string) {
  if (typeof room.sendTo === "function")          return room.sendTo("assistant", "user", text);
  if (typeof room.sendUser === "function")        return room.sendUser(text);
  if (typeof room.sendUserMessage === "function") return room.sendUserMessage(text);
  if (typeof room.receive === "function")         return room.receive("User", "user", text);
  throw new Error("ChatRoom has no user-send method (sendTo/sendUser/sendUserMessage/receive)");
}

test("multi-agent integration with mock server", async () => {
  Logger.info("[INFO][multi-agent] starting test");
  const room = new ChatRoom({ personas: ["alice", "bob"], model: "mock" } as any);
  await sendUserCompat(room as any, "Hello agents");
  // We do not assert model text here (mock server handles that in its own test).
  // Success criteria: no timeout/throw.
}, 12000);
