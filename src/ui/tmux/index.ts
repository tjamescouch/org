import * as path from "path";
import * as fsp from "fs/promises";
import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";

/** Modern options shape (can be called directly). */
export interface TmuxLaunchOpts {
  /** Host project directory mounted at /work inside the sandbox. */
  projectDir?: string;
  /** Sandbox key / agent session id. */
  agentSessionId?: string;
  /** App entry path (inside the sandbox). Defaults to /work/src/app.ts */
  entry?: string;
}

/** Internal: do the actual launch given normalized options. */
async function doLaunch(opts: Required<TmuxLaunchOpts>): Promise<number> {
  const { projectDir, agentSessionId, entry } = opts;

  Logger.info("[org/tmux] launcher start", { projectDir, agentSessionId, entry });

  // --- Preflight: check tmux inside the sandbox ---
  const check = await shInteractive(`command -v tmux >/dev/null 2>&1`, {
    projectDir,
    agentSessionId,
  });
  Logger.info("[org/tmux] tmux check (interactive rc)", { code: check.code });

  //if (check.code !== 0) {
  //  throw new Error(
  //    "tmux not found in the sandbox image. Please add tmux to the image used for the sandbox."
  //  );
  //}

  // Make a writable logs dir for tmux under /work
  const tmuxLogsDirHost = path.join(projectDir, ".org", "logs", "tmux-logs");
  try { await fsp.mkdir(tmuxLogsDirHost, { recursive: true }); } catch {}

  // tmux runs inside the sandbox; app runs in console mode within the session
  const tmuxCmd =
    `TMUX_TMPDIR=/work/.org/logs/tmux-logs ` +
    `/usr/bin/tmux -vv new-session -A -s org 'bun ${entry} --ui console'`;

  Logger.info("[org/tmux] exec", { cmd: tmuxCmd });

  const result = await shInteractive(tmuxCmd, { projectDir, agentSessionId });
  Logger.info("[org/tmux] tmux exited", { code: result.code });
  return result.code ?? 0;
}

/**
 * Back-compat wrapper:
 *  - If called as (argv, scope) from old code, normalize to options.
 *  - If called with an object, treat it as TmuxLaunchOpts.
 * Exported both as named and default so existing `const { launchTmuxUI } = await import(...)`
 * keeps working.
 */
export async function launchTmuxUI(
  a?: unknown,
  _scope?: unknown
): Promise<number> {
  // Defaults that work in both environments
  const projectDir =
    (process.env.ORG_CALLER_CWD && process.env.ORG_CALLER_CWD.trim()) ||
    process.cwd();
  const agentSessionId =
    (process.env.ORG_AGENT_SESSION_ID && process.env.ORG_AGENT_SESSION_ID.trim()) ||
    "default";
  const entry =
    (process.env.ORG_ENTRY && process.env.ORG_ENTRY.trim()) ||
    "/work/src/app.ts";

  let opts: TmuxLaunchOpts;

  if (a && typeof a === "object" && !Array.isArray(a)) {
    // New signature: launchTmuxUI({ projectDir, agentSessionId, entry })
    opts = a as TmuxLaunchOpts;
  } else {
    // Old signature: launchTmuxUI(argv, scope) — ignore details, infer from env
    opts = {};
  }

  return doLaunch({
    projectDir: opts.projectDir ?? projectDir,
    agentSessionId: opts.agentSessionId ?? agentSessionId,
    entry: opts.entry ?? entry,
  });
}

export default launchTmuxUI;
