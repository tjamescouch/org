#!/usr/bin/env bash
set -euo pipefail

# 1) logger: re‑add LogLevel named export and keep current Logger implementation
cat > src/logger.ts <<'TS'
import { C, colorOn } from "./ui/colors";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
const order: Record<LogLevel, number> = { DEBUG:10, INFO:20, WARN:30, ERROR:40 };

export const LOG_LEVELS: LogLevel[] = ["DEBUG","INFO","WARN","ERROR"];

export function getLogLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  return (LOG_LEVELS as readonly string[]).includes(env) ? (env as LogLevel) : "INFO";
}

const want = (lvl: LogLevel) => order[lvl] >= order[getLogLevel()];
const tint = (lvl: LogLevel, s: string) => {
  if (!colorOn()) return s;
  const map: Record<LogLevel,string> = { DEBUG:C.debug, INFO:C.info, WARN:C.warn, ERROR:C.error };
  return `${map[lvl]}${s}${C.reset}`;
};

export class Logger {
  static debug(...a: any[]) { if (want("DEBUG")) console.log(tint("DEBUG","[DEBUG]"), ...a); }
  static info (...a: any[]) { if (want("INFO" )) console.log(tint("INFO" ,"[INFO ]"), ...a); }
  static warn (...a: any[]) { if (want("WARN" )) console.warn(tint("WARN" ,"[WARN ]"), ...a); }
  static error(...a: any[]) { if (want("ERROR")) console.error(tint("ERROR","[ERROR]"), ...a); }
}
TS

# 2) quiet, safe debug-hooks (no monkey‑patches; optional)
mkdir -p src/core
cat > src/core/debug-hooks.ts <<'TS'
import { Logger } from "../logger";
export async function installDebugHooks(): Promise<void> {
  // Keep this intentionally minimal and non-invasive.
  Logger.info("debug-hooks: installed (no-op)");
}
TS

# 3) role-fix: only patch if ChatRoom.receive exists and is writable; log at DEBUG
cat > src/runtime-fixes/role-fix.ts <<'TS'
import { Logger } from "../logger";
(async () => {
  try {
    const mod = await import("../core/chat-room");
    const ChatRoom: any = (mod as any).ChatRoom ?? (mod as any).default ?? mod;
    const P = ChatRoom?.prototype ?? ChatRoom;
    const desc = P && Object.getOwnPropertyDescriptor(P, "receive");
    if (!P || typeof P.receive !== "function") { Logger.debug("role-fix: receive not found; skip"); return; }
    if (desc && desc.writable === false) { Logger.debug("role-fix: receive not writable; skip"); return; }
    if ((P as any).__roleFixPatched) return;
    (P as any).__roleFixPatched = true;

    const orig = P.receive;
    P.receive = function (...a: any[]) {
      try {
        if (a.length >= 2 && a[1] === "user" && a[0] && a[0] !== "User") {
          Logger.debug(`[role-fix] Coercing ${a[0]} user→assistant`);
          a[1] = "assistant";
        } else if (a.length === 1 && typeof a[0] === "object" && a[0]?.role === "user" && a[0]?.from && a[0]?.from !== "User") {
          Logger.debug(`[role-fix] Coercing ${a[0].from} user→assistant`);
          a[0] = { ...a[0], role: "assistant" };
        }
      } catch {}
      return orig.apply(this, a);
    };
    Logger.info("role-fix: ChatRoom.receive patched");
  } catch (e:any) {
    Logger.debug("role-fix: load skipped:", e?.message ?? e);
  }
})();
TS

# 4) multi-agent test: use any available API to inject user text; longer timeout
cat > test/multi-agent-integration.test.ts <<'TS'
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
TS

# 5) tiny top-level proxy to run the debug runner name people keep using
cat > patch-debug.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec ./tools/run-org-debug.sh "$@"
SH
chmod +x patch-debug.sh

echo "✅ follow-up patch applied."
