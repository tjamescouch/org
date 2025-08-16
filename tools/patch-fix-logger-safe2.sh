#!/usr/bin/env bash
set -euo pipefail

# 1) logger.ts – export a runtime LogLevel object + the type, keep logger behavior
cat > src/logger.ts <<'TS'
import { C, colorOn } from "./ui/colors";

/** Runtime enum-like object so tests can import { LogLevel } as a value. */
export const LogLevel = {
  DEBUG: "DEBUG",
  INFO:  "INFO",
  WARN:  "WARN",
  ERROR: "ERROR",
} as const;

/** TS type derived from the runtime object above. */
export type LogLevel = keyof typeof LogLevel;

const order: Record<LogLevel, number> = {
  DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40,
};

export const LOG_LEVELS: LogLevel[] = ["DEBUG","INFO","WARN","ERROR"];

export function getLogLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  return (LOG_LEVELS as readonly string[]).includes(env as any)
    ? (env as LogLevel)
    : "INFO";
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

# 2) SAFE MODE – gate network calls by wrapping global fetch (configurable, no brittle proto hacks)
mkdir -p src/runtime-fixes
cat > src/runtime-fixes/safe-mode.ts <<'TS'
import { Logger } from "../logger";

const SAFE = process.env.SAFE_MODE === "1";
if (!SAFE) { /* noop */ } else {
  try {
    const desc = Object.getOwnPropertyDescriptor(globalThis as any, "fetch");
    const orig = (globalThis as any).fetch?.bind(globalThis) as typeof fetch | undefined;

    if (!orig || !desc || !(desc.writable || desc.configurable)) {
      Logger.warn("safe-mode: global fetch not swappable on this runtime; continuing without gating.");
    } else {
      const waitForEnter = async () => {
        if (!process.stdout.isTTY || !process.stdin.isTTY) return;
        process.stdout.write("[SAFE] Press Enter to run next step…\n");
        let resolved = false;
        const onData = (buf: Buffer) => {
          if (buf.includes(10) || buf.includes(13)) { // newline
            resolved = true;
            clearInterval(timer);
            process.stdin.off("data", onData);
          }
        };
        const timer = setInterval(() => {
          if (!resolved) process.stdout.write("[waiting for user input…]\n");
        }, 1500);
        process.stdin.resume();
        process.stdin.on("data", onData);
        // Wait until resolved
        await new Promise<void>(r => {
          const check = () => resolved ? r() : setTimeout(check, 25);
          check();
        });
      };

      const gated: typeof fetch = async (...args) => {
        await waitForEnter();
        return orig(...args as any);
      };

      Object.defineProperty(globalThis as any, "fetch", {
        value: gated, configurable: true, writable: true
      });
      Logger.info("safe-mode: fetch gating installed");
    }
  } catch (e: any) {
    Logger.warn("safe-mode: install failed:", e?.message ?? e);
  }
}
TS

# 3) Ensure safe-mode bootstrap is loaded from app start
# (idempotent import; if SAFE_MODE!=1 it’s a no-op)
awk '
  NR==1 && $0 !~ /runtime-fixes\/safe-mode/ {
    print "import \"../runtime-fixes/safe-mode\";";
  }
  { print }
' src/orchestration/app.ts > src/orchestration/app.ts.__tmp__ && mv src/orchestration/app.ts.__tmp__ src/orchestration/app.ts

echo "✅ Patch applied: logger runtime export + safe-mode fetch gating + app bootstrap."
