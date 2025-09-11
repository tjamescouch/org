import { Logger } from "../logger";
import { R } from "../runtime/runtime";

const DEBUG = (() => {
  const v = (R.env.DEBUG ?? "").toString().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "debug";
})();

export function dbg(...a: any[]) {
  if (DEBUG) Logger.info("[DBG][input]", ...a);
}

export function enableRawMode() {
  if (R.stdin.isTTY) {
    try { (R.stdin as any).setRawMode(true); } catch (e) { Logger.error(e) }
  }
}

export function disableRawMode() {
  if (R.stdin.isTTY) {
    try { (R.stdin as any).setRawMode(false); } catch (e) { Logger.error(e) }
  }
}

export function pauseStdin() {
  try { R.stdin.pause(); } catch (e) { Logger.error(e) }
}

export function resumeStdin() {
  try { R.stdin.resume(); } catch (e) { Logger.error(e) }
}

export function isRaw(): boolean {
  return !!(R.stdin as any).isRaw;
}
