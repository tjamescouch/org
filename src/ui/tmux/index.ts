// src/ui/tmux/index.ts
// Tmux UI launcher – runs tmux *inside the sandbox* and attaches your app.
import * as path from "path";
import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";

type Scope = "sandbox" | "host";

/** Resolve the entrypoint we want tmux to launch (container path). */
function resolveEntryInContainer(projectDir: string): string {
  const hostEntry = path.join(projectDir, "src", "app.ts");
  // map host path -> container path (/work/…)
  const rel = path.relative(projectDir, hostEntry).split(path.sep).join("/");
  return `/work/${rel}`;
}

/**
 * Check for tmux *inside the sandbox* using an interactive exec so we get a real rc.
 * Returns 0 if tmux is present, non-zero otherwise.
 */
async function doctorTmux(scope: Scope, projectDir: string, agentSessionId: string): Promise<number> {
  if (scope !== "sandbox") {
    // We only care about tmux in the sandbox. Host checks can be added later if needed.
    return 0;
  }
  // Use a shell so PATH is respected; we only care about the rc.
  const rc = await shInteractive(
    `bash -lc "command -v tmux >/dev/null 2>&1"`,
    { projectDir, agentSessionId }
  );
  Logger.info("[org/tmux] tmux check (interactive rc)", { code: rc.code });
  return rc.code ?? 127;
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

  // Ensure tmux exists in the sandbox image
  const rc = await doctorTmux(tmuxScope, projectDir, agentSessionId);
  if (rc !== 0) {
    throw new Error("tmux not found in the sandbox image. Please add tmux to the image used for the sandbox.");
  }

  // Inside tmux, PATH is often trimmed. Make sure bun is discoverable:
  //   export PATH="$HOME/.bun/bin:$PATH"; exec bun …
  //
  // We also configure a tmux tmpdir for logs/sockets under /work/.org.
  const tmuxCmd =
    `bash -lc ` +
    `"mkdir -p /work/.org/logs/tmux-logs; ` +
    `export TMUX_TMPDIR=/work/.org/logs/tmux-logs; ` +
    `exec /usr/bin/tmux -vv new-session -A -s org ` +
    `'bash -lc \\\"export PATH=\\$HOME/.bun/bin:\\$PATH; exec bun ${entryCtr} --ui console\\\"'` +
    `"`; // close outer bash -lc

  Logger.info("[org/tmux] exec", { cmd: tmuxCmd });

  const result = await shInteractive(tmuxCmd, { projectDir, agentSessionId });
  Logger.info("[org/tmux] tmux exited", { code: result.code });

  return result.code ?? 0;
}
