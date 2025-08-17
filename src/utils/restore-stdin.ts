import { Logger } from "../logger";

export function restoreStdin(raw: boolean) {
  try {
    if (raw && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    if (process.env.DEBUG) Logger.info("[DBG] stdin resumed");
  } catch (e) {
    Logger.info("[DBG] failed to restore stdin:", e);
  }
}
