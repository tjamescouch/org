import { spawnSync } from "child_process";

let installed = false;

/**
 * Puts the TTY in a deterministic state for the whole UI session:
 *  - raw mode ON
 *  - echo OFF (stty -echo)
 * and restores on process exit.
 *
 * We keep echo off for the entire session so the terminal never does its own
 * echo; all live echo is produced by the UI code when in INTERJECT state.
 */
export function startTtySession(): void {
  if (installed) return;
  installed = true;

  const stdin = process.stdin as any;
  try { stdin.setRawMode?.(true); } catch { /* ignore */ }
  try { spawnSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] }); } catch { /* ignore */ }
  process.stdin.resume();

  const restore = () => {
    try { spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] }); } catch { /* ignore */ }
    try { stdin.setRawMode?.(false); } catch { /* ignore */ }
  };

  // Make sure we leave the TTY sane no matter how we exit
  process.once("exit", restore);
  process.once("SIGINT", () => { restore(); process.exit(130); });
  process.once("SIGTERM", () => { restore(); process.exit(143); });
}

/** Restore echo+raw if the session was started. Safe to call multiple times. */
export function stopTtySession(): void {
  if (!installed) return;
  installed = false;

  const stdin = process.stdin as any;
  try { spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] }); } catch { /* ignore */ }
  try { stdin.setRawMode?.(false); } catch { /* ignore */ }
}
