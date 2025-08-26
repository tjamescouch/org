// src/runtime/process-guards.ts
import { Logger } from "../logger";

export function setupProcessGuards() {
  const dbgOn = !!process.env.DEBUG && process.env.DEBUG !== "0" && process.env.DEBUG !== "false";
  if (!dbgOn) return;

  process.on("beforeExit", (code) => {
    Logger.info("[DBG] beforeExit", code, "— scheduler stays alive unless Ctrl+C");
    setTimeout(() => { /* keep loop alive while idle */ }, 60_000);
  });
  process.on("uncaughtException", (e) => { Logger.info("[DBG] uncaughtException:", e); });
  process.on("unhandledRejection", (e) => { Logger.info("[DBG] unhandledRejection:", e); });
  process.stdin.on("end", () => Logger.info("[DBG] stdin end"));
  process.stdin.on("pause", () => Logger.info("[DBG] stdin paused"));
  process.stdin.on("resume", () => Logger.info("[DBG] stdin resumed"));
}
