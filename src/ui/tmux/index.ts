import * as path from "path";
import * as fsp from "fs/promises";
import { Logger } from "../../logger";
import { shCapture, shInteractive } from "../../tools/sandboxed-sh";

export interface TmuxLaunchOpts {
  /** Host project directory that is mounted at /work in the sandbox. */
  projectDir?: string;
  /** Agent session id (sandbox key). */
  agentSessionId?: string;
  /** Entry file to run with bun inside the sandbox. Defaults to /work/src/app.ts */
  entry?: string;
}

/**
 * Launch the UI inside a tmux session that runs **in the sandbox**.
 * Falls back to a clear error only if tmux is genuinely missing in the image.
 */
export async function launchTmuxUI(opts: TmuxLaunchOpts = {}): Promise<{ code: number }> {
  // Robust defaults so we never pass undefined opts to shCapture/shInteractive.
  const projectDir = opts.projectDir ?? process.env.ORG_CALLER_CWD ?? process.cwd();
  const agentSessionId = opts.agentSessionId ?? "default";
  const entry = opts.entry ?? "/work/src/app.ts";

  Logger.info("[org/tmux] launcher start", { projectDir, agentSessionId, entry });

  // Verify tmux exists **inside the sandbox** (not on host).
  // Use POSIX 'command -v' (portable even if 'which' is absent).
  const check = await shCapture(
    `sh -lc 'command -v tmux >/dev/null 2>&1 && echo OK || echo MISSING'`,
    { projectDir, agentSessionId }
  );

  Logger.info("[org/tmux] tmux check", {
    code: check.code,
    stdout: check.stdout.trim(),
    stderr: check.stderr.trim(),
  });

  if (check.code !== 0 || check.stdout.trim() !== "OK") {
    throw new Error(
      "tmux not found in the sandbox image. Please add tmux to the image used for the sandbox."
    );
  }

  // Ensure a place for tmux verbose logs inside the mounted project.
  const tmuxLogsDir = path.join(projectDir, ".org", "logs", "tmux-logs");
  try { await fsp.mkdir(tmuxLogsDir, { recursive: true }); } catch { /* best-effort */ }

  // Run tmux inside the sandbox, and start our app in console mode within it.
  // - TMUX_TMPDIR points to a writeable path under /work so logging works.
  // - We attach the caller TTY via shInteractive, so Ctrl+C etc behave.
  const cmd = `bash -lc "TMUX_TMPDIR=/work/.org/logs/tmux-logs tmux -vv new-session -A -s org 'bun ${entry} --ui console'"`;
  Logger.info("[org/tmux] exec", { cmd });

  const result = await shInteractive(cmd, { projectDir, agentSessionId });

  Logger.info("[org/tmux] tmux exited", { code: result.code });
  return result;
}

export default launchTmuxUI;
