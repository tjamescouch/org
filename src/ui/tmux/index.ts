// src/ui/tmux/index.ts
import { shCapture, shInteractive, currentSandboxSessionKey } from "../../tools/sandboxed-sh";

const shq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function firstAgentIdFromArgv(argv: string[]): string {
  const i = argv.indexOf("--agents");
  if (i >= 0 && argv[i + 1]) {
    const first = argv[i + 1].split(",")[0]?.trim();
    const id = first?.split(":")[0]?.trim();
    if (id) return id;
  }
  return "alice";
}

export async function launchTmuxUI(argv: string[]): Promise<number> {
  // If we're already inside tmux, do nothing to avoid recursion.
  if (process.env.TMUX) return 0;

  const cwd = process.cwd();
  const fallback = firstAgentIdFromArgv(argv);
  const sessionKey = process.env.ORG_TMUX_SESSION || currentSandboxSessionKey() || fallback;

  // Ensure sandbox session exists (no-op if already present)
  await shCapture("true", { projectDir: cwd, agentSessionId: sessionKey });

  // Verify tmux is available *inside* the sandbox
  const check = await shCapture("command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1", {
    projectDir: cwd,
    agentSessionId: sessionKey,
  });
  if (check.code !== 0) {
    process.stderr.write(`tmux not found in sandbox session "${sessionKey}".\n`);
    return 1;
  }

  // Build inner argv: run org again but without "--ui tmux"
  const innerArgs = argv.filter((a, i, arr) => !(a === "--ui" || (a === "tmux" && arr[i - 1] === "--ui")));
  const innerCmd =
    `LOG_LEVEL=${process.env.LOG_LEVEL ?? "INFO"} DEBUG=${process.env.DEBUG ?? ""} ` +
    `org ${innerArgs.map(shq).join(" ")}`;

  // Keep the pane alive even if org exits; show exit code; drop into a shell.
  // NOTE: avoid 'set -u' and 'set -e' to prevent 'rc: unbound variable' on failures.
  const wrapped = [
    "set -o pipefail",
    "rc=0",
    innerCmd,
    "rc=$?",
    "echo",
    "echo \"[tmux-ui] org exited with code: $rc\"",
    "echo \"[tmux-ui] staying in shell; Ctrl-b d to detach\"",
    "exec bash -l"
  ].join(" ; ");

  // Create/ensure tmux server, respawn pane with wrapper, then attach (blocks)
  const script = [
    "set -o pipefail",
    "tmux has-session -t org 2>/dev/null || tmux new-session -s org -d",
    `tmux respawn-pane -k -t org.0 "bash -lc ${shq(wrapped)}"`,
    "tmux attach -t org"
  ].join(" ; ");

  process.stderr.write(`[tmux-ui] session=${sessionKey} cwd=${cwd}\n`);
  process.stderr.write(`[tmux-ui] reexec: ${innerCmd}\n`);

  const run = await shInteractive(`bash -lc ${shq(script)}`, {
    projectDir: cwd,
    agentSessionId: sessionKey,
    tty: true,
    inheritStdio: true,
  });

  return run.code ?? 0;
}
