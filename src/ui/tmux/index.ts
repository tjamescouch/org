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
 * Start (or attach to) a tmux session and run `org` inside it.
 * Uses a two-step (belt-and-suspenders) flow:
 *  1) create/ensure session detached
 *  2) respawn pane with the org command
 *  3) attach to the session (foreground, stays until user exits)
 */
export async function launchTmuxUI(argv: string[]): Promise<number> {
  // Avoid infinite recursion if we are already inside tmux
  if (process.env.TMUX) return 0;

  const cwd = process.cwd();
  const fallback = firstAgentIdFromArgv(argv);
  const sessionKey = process.env.ORG_TMUX_SESSION || currentSandboxSessionKey() || fallback;

  // Make sure the sandbox session exists (no-op if it does)
  await shCapture("true", { projectDir: cwd, agentSessionId: sessionKey });

  // Check tmux inside THAT sandbox
  const check = await shCapture("command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1", {
    projectDir: cwd,
    agentSessionId: sessionKey,
  });
  if (check.code !== 0) {
    process.stderr.write(
      `tmux not found in sandbox session "${sessionKey}". Ensure the image installs tmux.\n`
    );
    return 1;
  }

  // Command to re-exec org (without recursively launching tmux)
  const reexec = `LOG_LEVEL=${process.env.LOG_LEVEL ?? "INFO"} DEBUG=${process.env.DEBUG ?? ""} ` +
                 `exec ${argv.filter(a => a !== "--ui" && a !== "tmux").map(shq).join(" ")}`;

  // Two-step attach flow:
  //  - create session if missing (-d keeps it up even if client drops briefly)
  //  - respawn the first pane with our command (so we always run fresh)
  //  - attach; this call should BLOCK until the user detaches/exits
  const script = [
    "set -euo pipefail",
    "tmux has-session -t org 2>/dev/null || tmux new-session -s org -d",
    `tmux respawn-pane -k -t org.0 "bash -lc ${shq(reexec)}"`,
    "tmux attach -t org"
  ].join("; ");

  // Helpful trace
  process.stderr.write(`[tmux-ui] session=${sessionKey} cwd=${cwd}\n`);
  process.stderr.write(`[tmux-ui] reexec: ${reexec}\n`);

  const run = await shInteractive(`bash -lc ${shq(script)}`, {
    projectDir: cwd,
    agentSessionId: sessionKey,
    tty: true,
    inheritStdio: true,
  });

  return run.code ?? 0;
}
