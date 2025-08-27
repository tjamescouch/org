// src/ui/tmux/index.ts
import { shCapture, shInteractive, currentSandboxSessionKey } from "../../tools/sandboxed-sh";

/** single-quote shell-escape */
function shq(s: string) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/** Extract first agent id from --agents "<id>:kind,..." */
function firstAgentIdFromArgv(argv: string[]): string {
  const i = argv.indexOf("--agents");
  if (i >= 0 && argv[i + 1]) {
    const first = argv[i + 1].split(",")[0]?.trim();
    const id = first?.split(":")[0]?.trim();
    if (id) return id;
  }
  return "alice";
}

/**
 * Launch org inside tmux *in the sandbox* (same session as agents).
 * - Picks session from ORG_TMUX_SESSION, or the first agent id, or last used.
 * - Requires that your sandbox backend supports interactive exec with a TTY.
 */
export async function launchTmuxUI(argv: string[]): Promise<number> {
  if (process.env.TMUX || process.env.ORG_TMUX === "1") return 0; // avoid recursion

  const cwd = process.cwd();

  // Choose the same session as the agents (or allow override)
  const fallback = firstAgentIdFromArgv(argv);
  const sessionKey =
    process.env.ORG_TMUX_SESSION ||
    currentSandboxSessionKey() ||
    fallback;

  // Make sure session exists (no-op if already present)
  await shCapture("true", { projectDir: cwd, agentSessionId: sessionKey });

  // Check tmux availability in THAT session
  const check = await shCapture("command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1", {
    projectDir: cwd,
    agentSessionId: sessionKey,
  });
  if (check.code !== 0) {
    process.stderr.write(
      `tmux not found in sandbox session "${sessionKey}". ` +
      `Ensure your sandbox image includes tmux and the UI uses the same session as agents.\n`
    );
    return 1;
  }

  // Re-exec org inside tmux; ORG_TMUX=1 prevents recursion when org starts again
  const reexec = `export ORG_TMUX=1; exec ${argv.map(shq).join(" ")}`;
  const tmuxCmd = `tmux new-session -A -D -s org bash -lc ${shq(reexec)}`;

  const run = await shInteractive(tmuxCmd, {
    projectDir: cwd,
    agentSessionId: sessionKey,
    tty: true,
    inheritStdio: true,
  });
  return run.code ?? 0;
}
