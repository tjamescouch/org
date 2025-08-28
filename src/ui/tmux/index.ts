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
 * - Preflight tmux using a single-shell interactive check (no nested sh -lc),
 *   so we avoid quoting pitfalls and RC=127 false negatives.
 * - Return a plain number (exit code) so callers can `process.exit(...)`.
 */
export default async function launchTmuxUI(
  opts: TmuxLaunchOpts = {}
): Promise<number> {
  // Robust defaults so we never pass undefined to shInteractive():
  const projectDir = opts.projectDir ?? process.env.ORG_CALLER_CWD ?? process.cwd();
  const agentSessionId = opts.agentSessionId ?? "default";
  const entry = opts.entry ?? "/work/src/app.ts";

  Logger.info("[org/tmux] launcher start", { projectDir, agentSessionId, entry });

  // --- Preflight: check tmux INSIDE the sandbox (return-code only) ---
  // IMPORTANT: pass only the test command; shInteractive already wraps with a shell.
  const check = await shInteractive(
    `command -v tmux >/dev/null 2>&1`,
    { projectDir, agentSessionId }
  );
  Logger.info("[org/tmux] tmux check (interactive rc)", { code: check.code });

  if (check.code !== 0) {
    // If you want silent fallback to console later, we can add it; for now be explicit.
    throw new Error(
      "tmux not found in the sandbox image. Please add tmux to the image used for the sandbox."
    );
  }

  // Ensure a writable logs dir for tmux -vv (under /work in the sandbox)
  const tmuxLogsDir = path.join(projectDir, ".org", "logs", "tmux-logs");
  try { await fsp.mkdir(tmuxLogsDir, { recursive: true }); } catch { /* best-effort */ }

  // Launch tmux inside the sandbox and run our app in console mode within the session.
  // TMUX_TMPDIR is set under /work so the sandbox can write logs.
  // NOTE: Only one shell wrapping — shInteractive adds the shell; we pass the literal tmux command here.
  const tmuxCmd =
    `TMUX_TMPDIR=/work/.org/logs/tmux-logs ` +
    `tmux -vv new-session -A -s org 'bun ${entry} --ui console'`;

  Logger.info("[org/tmux] exec", { cmd: tmuxCmd });

  const result = await shInteractive(tmuxCmd, { projectDir, agentSessionId });
  Logger.info("[org/tmux] tmux exited", { code: result.code });

  // Return a PLAIN NUMBER so app.ts can `process.exit(code ?? 0)` safely.
  return result.code ?? 0;
}
