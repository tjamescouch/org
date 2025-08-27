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
  if (process.env.TMUX) return 0; // already inside tmux

  const cwd = process.cwd();
  const fallback = firstAgentIdFromArgv(argv);
  const sessionKey = process.env.ORG_TMUX_SESSION || currentSandboxSessionKey() || fallback;

  // Ensure sandbox session exists
  await shCapture("true", { projectDir: cwd, agentSessionId: sessionKey });

  // tmux availability inside sandbox
  const check = await shCapture("command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1", {
    projectDir: cwd,
    agentSessionId: sessionKey,
  });
  if (check.code !== 0) {
    process.stderr.write(`tmux not found in sandbox session "${sessionKey}".\n`);
    return 1;
  }

  // Build inner argv for org: drop the UI flag so the inner run doesn't recurse
  const innerArgs = argv.filter((a, i, arr) => !(a === "--ui" || (a === "tmux" && arr[i - 1] === "--ui")));

  // NOTE: no 'exec' here — we want to continue the wrapper afterward
  const innerCmd =
    `LOG_LEVEL=${process.env.LOG_LEVEL ?? "INFO"} DEBUG=${process.env.DEBUG ?? ""} ` +
    `org ${innerArgs.map(shq).join(" ")}`;

  // Wrapper keeps pane open, shows exit code, then drops into an interactive shell
  const wrapped = [
    "set -euo pipefail",
    "rc=0",
    // run the command; always record its exit code even if it fails under -e
    `{ " + innerCmd + " ; rc=$?; } || rc=$?`,
    "echo",
    "echo \"[tmux-ui] org exited with code: $rc\"",
    "echo \"[tmux-ui] staying in shell; Ctrl-b d to detach\"",
    "exec bash -l"
  ].join(" ; ");

  // Create/ensure tmux server, respawn pane with wrapper, attach
  const script = [
    "set -euo pipefail",
    "tmux has-session -t org 2>/dev/null || tmux new-session -s org -d",
    `tmux respawn-pane -k -t org.0 "bash -lc ${shq(wrapped)}"`,
    "tmux attach -t org"
  ].join("; ");

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
