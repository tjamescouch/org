export function restoreStdin(raw: boolean) {
  try {
    if (raw && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    if (process.env.DEBUG) console.error("[DBG] stdin resumed");
  } catch (e) {
    console.error("[DBG] failed to restore stdin:", e);
  }
}
