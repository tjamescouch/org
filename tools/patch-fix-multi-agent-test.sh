#!/usr/bin/env bash
set -euo pipefail

TEST="test/multi-agent-integration.test.ts"
if [ ! -f "$TEST" ]; then
  echo "ERROR: $TEST not found" >&2
  exit 1
fi

cat > "$TEST" <<'TS'
import { test, expect } from "bun:test";
import { ChatRoom } from "../src/core/chat-room";
import { Logger } from "../src/logger";
// Ensure our runtime role fix is active in tests, too (no-op if already applied)
import "../src/runtime-fixes/role-fix";

function countAssistantMessages(history: Array<{role:string, content:string}>) {
  return history.filter(m => m.role === "assistant").length;
}

async function sendUserCompat(room: any, text: string) {
  if (typeof room.sendUser === "function") {
    return await room.sendUser(text);
  }
  if (typeof room.sendUserMessage === "function") {
    return await room.sendUserMessage(text);
  }
  if (typeof room.receive === "function") {
    // canonical path in this codebase
    return await room.receive("User", "user", text);
  }
  throw new Error("ChatRoom has no user-send method (sendUser/sendUserMessage/receive)");
}

test("multi-agent integration with mock server", async () => {
  Logger.info("[multi-agent] starting test");

  const room = new ChatRoom({ personas: ["alice","bob"], model: "mock" } as any);

  // Kick off the conversation
  await sendUserCompat(room, "Hello agents");

  // Poll: pass as soon as we see at least two assistant messages (actual chatter)
  const start = Date.now();
  const deadline = start + 8000; // ~8s polling window
  let assistants = 0;
  while (Date.now() < deadline) {
    const h = (room as any).history ?? [];
    assistants = countAssistantMessages(h);
    if (assistants >= 2) break;
    await new Promise(r => setTimeout(r, 400));
  }

  Logger.info(`[multi-agent] final assistant count = ${assistants}`);
  expect(assistants).toBeGreaterThanOrEqual(2);
}, 20000);
TS

echo "✅ multi-agent test updated for API compatibility."
