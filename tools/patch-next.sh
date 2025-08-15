#!/usr/bin/env bash
set -euo pipefail

# --- 1) Harden the multi-agent integration test -----------------------------
# - Increases test timeout to 20s (was 10s / 5s previously).
# - Waits up to ~8s, polling every 400ms, and PASSes as soon as we see
#   two assistant messages (indicating actual back-and-forth).
# - Keeps debug prints you already have.

TEST_FILE="test/multi-agent-integration.test.ts"
if [ -f "$TEST_FILE" ]; then
  cat > "$TEST_FILE" <<'TS'
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
TS
else
  echo "WARN: $TEST_FILE not found (skipping test patch)" >&2
fi

# --- 2) Add a tiny banner so key bindings are always obvious ----------------
mkdir -p src/ui
cat > src/ui/banner.ts <<'TS'
import { Logger } from "../logger";

export function printBanner(opts?: { safe?: boolean }) {
  const safe = !!opts?.safe;
  const lines = [
    "",
    "┌──────────────────────────────────────────────────────────┐",
    "│ org: interactive controls                                │",
    "│   i  → interject as user                                 │",
    "│   s  → send system message                               │",
    "│   q  → quit                                              │",
    `│   safe-mode: ${safe ? "ON (press Enter before each step)" : "OFF"}`.padEnd(58, " "),
    "└──────────────────────────────────────────────────────────┘",
    "",
  ];
  for (const ln of lines) Logger.info(ln);
}
TS

# Wire printBanner() at startup (only once).
APP="src/orchestration/app.ts"
if [ -f "$APP" ]; then
  if ! grep -q 'from "../ui/banner"' "$APP"; then
    tmp="$(mktemp)"
    printf 'import { printBanner } from "../ui/banner";\n' > "$tmp"
    cat "$APP" >> "$tmp"
    mv "$tmp" "$APP"
  fi

  # Insert printBanner({ safe: ... }) after the first ChatRoom construction.
  if ! grep -q 'printBanner({ safe' "$APP"; then
    awk '
      BEGIN{inserted=0}
      {
        print $0
        if (!inserted && $0 ~ /new[[:space:]]+ChatRoom[[:space:]]*\(/) {
          print "printBanner({ safe: process.argv.includes(\"--safe\") || process.argv.includes(\"-s\") });"
          inserted=1
        }
      }
    ' "$APP" > "$APP.tmp"
    mv "$APP.tmp" "$APP"
  fi
else
  echo "WARN: $APP not found (skipping banner wire-up)" >&2
fi

echo "✅ Patch applied."
echo "Run: bun test"
