// src/ui/tmux/index.ts
import { spawnSync } from "node:child_process";
import { shCapture, shInteractive, currentSandboxSessionKey } from "../../tools/sandboxed-sh";
import { R } from "../../runtime/runtime";

function shq(s: string) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

export async function launchTmuxUI(argv: string[]): Promise<number> {
  // Don’t re-enter endlessly
  if (R.env.TMUX || R.env.ORG_TMUX === "1") return 0;

  // Use the *same* sandbox session the rest of the app has been using.
  const sessionKey = currentSandboxSessionKey() ?? "default";
  const cwd = typeof (R as any)?.cwd === "function" ? (R as any).cwd() : R.cwd();

  // Verify tmux is available *inside that same session*
  const check = await shCapture("command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1", {
    projectDir: cwd,
    agentSessionId: sessionKey
  });
  if (check.code !== 0) {
    R.stderr.write(
      `tmux not found in sandbox session "${sessionKey}". ` +
      `Ensure your sandbox image includes tmux and you are using the same session (${sessionKey}).\n`
    );
    return 1;
  }

  // Compose the re-exec payload and launch tmux within the sandbox
  const reexec = `export ORG_TMUX=1; exec ${argv.map(shq).join(" ")}`;
  const tmuxCmd = `tmux new-session -A -D -s org bash -lc ${shq(reexec)}`;

  const r = await shInteractive(tmuxCmd, {
    projectDir: cwd,
    agentSessionId: sessionKey,
    tty: true,
    inheritStdio: true,
  });

  return r.code ?? 0;
}
