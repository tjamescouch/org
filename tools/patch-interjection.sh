#!/usr/bin/env bash
set -euo pipefail

# 1) Add the key-input module
mkdir -p src/ui
cat > src/ui/key-input.ts <<'TS'
import { ChatRoom } from "../orchestration/chat-room"; // adjust if your path differs
import { Logger } from "../logger";

type KeyHandlerOpts = {
  room: ChatRoom;
  onQuit?: () => void;
};

/**
 * Sets up raw-key input:
 *  - 'i' : enter user interjection mode, type your line, press Enter
 *  - 's' : enter system prompt mode, type your line, press Enter
 *  - 'q' : quit
 * Shows a "[waiting for user input…]" ticker once per second while capturing
 * if SHOW_WAIT_TICK=1 is set in the environment.
 */
export function setupKeyInput({ room, onQuit }: KeyHandlerOpts) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  // Avoid multiple attachments
  if ((stdin as any).__orgKeysAttached) return;
  (stdin as any).__orgKeysAttached = true;

  if (stdin.isTTY) {
    stdin.setRawMode?.(true);
  }
  stdin.resume();
  stdin.setEncoding("utf8");

  type Mode = "none" | "user" | "system";
  let captureMode: Mode = "none";
  let lineBuf = "";

  const flushPrompt = () => {
    stdout.write("\n");
    if (captureMode === "user") stdout.write("🗣️  Interject> ");
    if (captureMode === "system") stdout.write("⚙️  System> ");
  };

  const SHOW_WAIT_TICK = process.env.SHOW_WAIT_TICK === "1";
  let waitingTimer: NodeJS.Timeout | undefined;

  const startWaitingTicker = () => {
    if (!SHOW_WAIT_TICK) return;
    stopWaitingTicker();
    waitingTimer = setInterval(() => {
      if (captureMode !== "none") {
        stdout.write("\r[waiting for user input…]      ");
        flushPrompt();
      }
    }, 1000);
  };
  const stopWaitingTicker = () => {
    if (waitingTimer) clearInterval(waitingTimer);
    waitingTimer = undefined;
  };

  const commitInterjection = async () => {
    const text = lineBuf.trim();
    lineBuf = "";
    if (!text) return;

    try {
      if (captureMode === "user") {
        // Mark this as an interjection; adapt to your room API if needed
        await (room as any).sendUser?.(text, { interjection: true })
          ?? (room as any).sendTo?.("assistant", "user", text)
          ?? Promise.reject(new Error("room.sendUser/sendTo not found"));
      } else if (captureMode === "system") {
        await (room as any).sendSystem?.(text)
          ?? (room as any).sendTo?.("assistant", "system", text)
          ?? Promise.reject(new Error("room.sendSystem/sendTo not found"));
      }
    } catch (err) {
      Logger.error(`interjection commit failed: ${(err as Error).message}`);
    } finally {
      captureMode = "none";
      stopWaitingTicker();
      stdout.write("\n");
    }
  };

  stdin.on("data", async (ch: string) => {
    try {
      // Ctrl-C or 'q' -> quit
      if (ch === "\u0003" || ch === "q") {
        Logger.info("Quit requested.");
        stdin.setRawMode?.(false);
        stopWaitingTicker();
        stdin.pause();
        onQuit?.();
        return;
      }

      // If not capturing, treat as single-key commands
      if (captureMode === "none") {
        if (ch === "i") {
          captureMode = "user";
          flushPrompt();
          startWaitingTicker();
          return;
        }
        if (ch === "s") {
          captureMode = "system";
          flushPrompt();
          startWaitingTicker();
          return;
        }
        // ignore other keys in normal mode
        return;
      }

      // Capturing a line
      if (ch === "\r" || ch === "\n") {
        await commitInterjection();
        return;
      }
      if (ch === "\u0008" || ch === "\u007f") { // Backspace
        if (lineBuf.length > 0) {
          lineBuf = lineBuf.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (ch >= " " && ch <= "~") {
        lineBuf += ch;
        stdout.write(ch);
      }
    } catch (err) {
      Logger.error(`key handler error: ${(err as Error).message}`);
    }
  });

  const reset = () => {
    stopWaitingTicker();
    stdin.setRawMode?.(false);
    stdin.pause();
  };
  process.on("exit", reset);
  process.on("SIGINT", () => { reset(); process.exit(130); });
}
TS

# 2) Wire it into src/orchestration/app.ts:
APP=src/orchestration/app.ts
if [ ! -f "$APP" ]; then
  echo "ERROR: $APP not found. Adjust path if your file lives elsewhere." >&2
  exit 1
fi

# Insert import at top (only if not present)
if ! grep -q 'from "../ui/key-input"' "$APP"; then
  tmpfile="$(mktemp)"
  printf 'import { setupKeyInput } from "../ui/key-input";\n' > "$tmpfile"
  cat "$APP" >> "$tmpfile"
  mv "$tmpfile" "$APP"
fi

# Insert setupKeyInput call right after the first occurrence of "new ChatRoom("
# We add a line: setupKeyInput({ room, onQuit: () => process.exit(0) });
if ! grep -q 'setupKeyInput({ room' "$APP"; then
  awk '
    BEGIN{inserted=0}
    {
      print $0
      if (!inserted && $0 ~ /new[[:space:]]+ChatRoom[[:space:]]*\(/) {
        print "setupKeyInput({ room, onQuit: () => process.exit(0) });"
        inserted=1
      }
    }
  ' "$APP" > "$APP.tmp"
  mv "$APP.tmp" "$APP"
fi

echo "✅ Interjection keys wired. Build & run:"
echo "   SHOW_WAIT_TICK=1 bun test     # to verify nothing breaks"
echo "   SHOW_WAIT_TICK=1 bun run org.ts  # try i / s / q in the CLI"
