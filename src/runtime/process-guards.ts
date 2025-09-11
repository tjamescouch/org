// src/runtime/R-guards.ts
import { Logger } from "../logger";
import { R } from "./runtime";

export function setupRGuards() {
  const dbgOn = !!R.env.DEBUG && R.env.DEBUG !== "0" && R.env.DEBUG !== "false";
  if (!dbgOn) return;

  R.on("beforeExit", (code) => {
    Logger.info("[DBG] beforeExit", code, "— scheduler stays alive unless Ctrl+C");
    setTimeout(() => { /* keep loop alive while idle */ }, 60_000);
  });
  R.on("uncaughtException", (e) => { Logger.info("[DBG] uncaughtException:", e); });
  R.on("unhandledRejection", (e) => { Logger.info("[DBG] unhandledRejection:", e); });
  R.stdin.on("end", () => Logger.info("[DBG] stdin end"));
  R.stdin.on("pause", () => Logger.info("[DBG] stdin paused"));
  R.stdin.on("resume", () => Logger.info("[DBG] stdin resumed"));
}
