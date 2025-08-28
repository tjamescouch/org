import * as path from "path";
import * as fsp from "fs/promises";
import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";

export interface TmuxLaunchOpts {
  /** Host project directory mounted at /work inside the sandbox. */
  projectDir?: string;
  /** Sandbox key / agent session id. */
  agentSessionId?: string;
  /** App entry path (inside the sandbox). Defaults to /work/src/app.ts */
  entry?: string;
}

/**
 * Launch UI under tmux that runs **inside the sandbox**.
 * Preflight tmux availability using an interactive zero-output test,
 * so we don't rely on capture being implemented.
 */
export async function launchTmuxUI(
  opts: TmuxLaunchOpts = {}
): Promise<{ code: number }> {
  // Robust defaults so we never pass undefined to shInteractive():
  const projectDir = opts.projectDir ?? process.env.ORG_CALLER_CWD ?? process.cwd();
  const agentSessionId = opts.agentSessionId ?? "default";
  const entry = opts.entry ?? "/work/src/app.ts";

  Logger.info("[org/tmux] launcher start", { projectDir, agentSessionId, entry });

  // --- Preflight: check tmux INSIDE the sandbox (return-code only; no capture) ---
  // Using interactive avoids PodmanSession.execCapture which may be unimplemented.
  const check = await shInteractive(
    `sh -lc 'command -v tmux >/dev/null 2>&1'`,
    { projectDir, agentSessionId }
  );

  Logger.info("[org/tmux] tmux check (interactive rc)", { code: check.code });

  if (check.code !== 0) {
    // If you prefer silent fallback to console UI, we can add that later;
    // for now a clear error is better signal during bring-up.
    throw new Error(
      "tmux not found in the sandbox image. Please add tmux to the image used for the sandbox."
    );
  }

  // Ensure a writable logs dir for tmux -vv (under /work in the sandbox)
  const tmuxLogsDir = path.join(projectDir, ".org", "logs", "tmux-logs");
  try { await fsp.mkdir(tmuxLogsDir, { recursive: true }); } catch { /* best-effort */ }

  // Launch tmux inside the sandbox and run our app in console mode within the session.
  // TMUX_TMPDIR is set under /work so the sandbox can write logs.
  const cmd = `bash -lc "TMUX_TMPDIR=/work/.org/logs/tmux-logs tmux -vv new-session -A -s org 'bun ${entry} --ui console'"`;
  Logger.info("[org/tmux] exec", { cmd });

  const result = await shInteractive(cmd, { projectDir, agentSessionId });
  Logger.info("[org/tmux] tmux exited", { code: result.code });

  return result;
}

export default launchTmuxUI;
