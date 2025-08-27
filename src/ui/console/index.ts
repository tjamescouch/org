/* eslint-disable no-console */
/**
 * Console UI used by tests and by default when no tmux UI is requested.
 *
 * This module is intentionally minimal and *does not* try to do any of the
 * “capture text” heavy lifting — that’s delegated to InputController’s FSM.
 * The console UI here only:
 *   - controls raw mode while idle (so ESC / hotkeys reach the FSM),
 *   - offers a simple yes/no prompt when a patch exists,
 *   - returns an exit code for the outer runner.
 *
 * IMPORTANT: there is NO per-character echo here. Any interactive entry
 * happens via readline inside InputController, which is the single source of
 * truth for TTY echo/editing. That prevents the dreaded double-echo bug.
 */

import * as fs from "fs";
import * as path from "path";

function trace(msg: string) {
  const on = process.env.ORG_DEBUG === "1" || process.env.DEBUG === "1";
  if (on) process.stderr.write(`[console-ui] ${msg}\n`);
}

function setRaw(on: boolean) {
  if (process.stdin.isTTY) {
    try { (process.stdin as any).setRawMode?.(on); } catch { /* ignore */ }
  }
}

function enableRaw(): () => void {
  const wasRaw = Boolean(process.stdin.isTTY && (process.stdin as any).isRaw);
  setRaw(true);
  process.stdin.resume();
  return () => { if (!wasRaw) setRaw(false); };
}

function findLastSessionPatch(cwd: string): string | null {
  try {
    const runs = path.join(cwd, ".org", "runs");
    const entries = fs.readdirSync(runs);
    const withTimes = entries.map((d) => {
      const p = path.join(runs, d, "session.patch");
      try {
        const st = fs.statSync(p);
        return st.isFile() && st.size > 0 ? { p, t: st.mtimeMs } : null;
      } catch { return null; }
    }).filter(Boolean) as { p: string; t: number }[];
    if (withTimes.length === 0) return null;
    withTimes.sort((a, b) => a.t - b.t);
    return withTimes[withTimes.length - 1].p;
  } catch {
    return null;
  }
}

async function yesNo(question: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const restore = enableRaw();
    process.stdout.write(`${question} [y/N] `);
    const on = (buf: Buffer) => {
      const s = buf.toString("binary");
      if (s === "y" || s === "Y") { cleanup(true); }
      else if (s === "n" || s === "N" || s === "\x1b" || s === "\r" || s === "\n") { cleanup(false); }
    };
    const cleanup = (ans: boolean) => {
      process.stdin.off("data", on);
      process.stdout.write("\n");
      restore();
      resolve(ans);
    };
    process.stdin.on("data", on);
  });
}

export async function launchConsoleUI(_argv: string[]): Promise<number> {
  trace("start");
  const restore = enableRaw();
  let exitCode = 0;

  // The InputController FSM owns interactive input; here we just detect ESC to
  // optionally prompt for applying the patch (when present).
  await new Promise<void>((resolve) => {
    const on = async (buf: Buffer) => {
      const s = buf.toString("binary");

      // ESC pressed while at top-level — check for a patch and ask
      if (s === "\x1b") {
        const patch = findLastSessionPatch(process.cwd());
        trace(`ESC -> patch=${patch ?? "<none>"}`);
        process.stdin.off("data", on);
        if (!patch) {
          exitCode = 0;
          restore();
          return resolve();
        }
        // Delegate to yes/no prompt (cooked echo inside)
        const ok = await yesNo("Apply this patch?");
        // We only *ask* here. Actual applying is done by outer logic.
        exitCode = 0;
        restore();
        return resolve();
      }

      // Let Ctrl+C bubble to the outer process
      if (s === "\x03") return;
    };

    process.stdin.on("data", on);
  });

  trace(`exit code=${exitCode}`);
  return exitCode;
}
