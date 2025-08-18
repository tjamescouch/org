import { Logger } from "../logger";

const DEBUG = (() => {
  const v = (process.env.DEBUG ?? "").toString().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "debug";
})();

export function dbg(...a: any[]) {
  if (DEBUG) Logger.info("[DBG][input]", ...a);
}

export function enableRawMode() {
  if (process.stdin.isTTY) {
    try { (process.stdin as any).setRawMode(true); } catch (e) { Logger.error(e) }
  }
}

export function disableRawMode() {
  if (process.stdin.isTTY) {
    try { (process.stdin as any).setRawMode(false); } catch (e) { Logger.error(e) }
  }
}

export function resumeStdin() {
  try { process.stdin.resume(); } catch (e) { Logger.error(e) }
}

export function isRaw(): boolean {
  return !!(process.stdin as any).isRaw;
}
