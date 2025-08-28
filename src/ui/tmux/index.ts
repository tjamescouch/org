// Tmux UI launcher – runs tmux *inside the sandbox* and attaches your app.
import * as path from "path";
import { Logger } from "../../logger";
import { shCapture, shInteractive } from "../../tools/sandboxed-sh";

type Scope = "sandbox" | "host";

/**
 * Doctor tmux inside the sandbox. Returns the exit code of `/usr/bin/tmux -V`.
 * 0 means tmux is available; anything else means it's missing/broken.
 */
async function doctorTmux(scope: Scope, projectDir: string, agentSessionId: string): Promise<number> {
  // We always check in the sandbox; host checks are optional and fast to add later.
  if (scope !== "host") {
    const check = await shCapture("/usr/bin/tmux -V", { projectDir, agentSessionId });
    Logger.info("[org/tmux] tmux check (interactive rc)", { code: check.code, stdout: check.stdout.trim(), stderr: check.stderr.trim() });
    return check.code ?? 127;
  }
  // host scope: accept success by default (we don't depend on host tmux)
  return 0;
}

/** Resolve the entrypoint we want tmux to launch (container path). */
function resolveEntryInContainer(projectDir: string): string {
  const hostEntry = path.join(projectDir, "src", "app.ts");
  // map host path -> container path (/work/…)
  const rel = path.relative(projectDir, hostEntry).split(path.sep).join("/");
  return `/work/${rel}`;
}

/**
 * Launch tmux UI inside the sandbox and attach the console UI as the session command.
 * Returns the process exit code (number).
 */
export async function launchTmuxUI(argv: string[], tmuxScope: Scope = "sandbox"): Promise<number> {
  const projectDir = process.cwd();
  const agentSessionId = "default";
  const entryCtr = resolveEntryInContainer(projectDir);

  Logger.info("[org/tmux] launcher start", {
    projectDir,
    agentSessionId,
    entry: entryCtr,
  });

  // Make sure tmux exists in the sandbox image.
  const rc = await doctorTmux(tmuxScope, projectDir, agentSessionId);
  if (rc !== 0) {
    throw new Error("tmux not found in the sandbox image. Please add tmux to the image used for the sandbox.");
  }

  // Build one clean interactive command string. We:
  //  - ensure the tmux log dir exists
  //  - point TMUX_TMPDIR there so tmux can write logs/sockets
  //  - launch a named session "org" (attach if it exists) that runs our console UI
  //
  // Notes on quoting:
  //  outer  : bash -lc " … 'bash -lc \"exec bun … --ui console\"' "
  //  inner  : we want tmux to run `bash -lc "exec bun /work/src/app.ts --ui console"`
  const tmuxCmd =
    `bash -lc ` +
    `"mkdir -p /work/.org/logs/tmux-logs; ` +
    `export TMUX_TMPDIR=/work/.org/logs/tmux-logs; ` +
    `exec /usr/bin/tmux -vv new-session -A -s org ` +
    `'bash -lc \\\"exec bun ${entryCtr} --ui console\\\"'` +
    `"`;

  Logger.info("[org/tmux] exec", { cmd: tmuxCmd });

  const result = await shInteractive(tmuxCmd, { projectDir, agentSessionId });
  Logger.info("[org/tmux] tmux exited", { code: result.code });

  return result.code ?? 0;
}
