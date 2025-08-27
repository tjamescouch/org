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
  const sessionKey = process.env.ORG_TMUX_SESSION || currentSandboxSessionKey() || firstAgentIdFromArgv(argv);

  // Ensure sandbox session exists (no-op if present)
  await shCapture("true", { projectDir: cwd, agentSessionId: sessionKey });

  // Check tmux availability inside sandbox
  const check = await shCapture("command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1", {
    projectDir: cwd,
    agentSessionId: sessionKey,
  });
  if (check.code !== 0) {
    process.stderr.write(`tmux not found in sandbox session "${sessionKey}".\n`);
    return 1;
  }

  // Use a dedicated tmux server socket so all commands hit the same server.
  const TMUX = "tmux -L orgsrv";

  // Inner org invocation (drop the UI flag so we don't recurse)
  const innerArgs = argv.filter((a, i, arr) => !(a === "--ui" || (a === "tmux" && arr[i - 1] === "--ui")));
  const orgCmd = `LOG_LEVEL=${process.env.LOG_LEVEL ?? "INFO"} DEBUG=${process.env.DEBUG ?? ""} org ${innerArgs.map(shq).join(" ")}`;

  // Wrapper: run org, capture exit, keep pane open in an interactive shell.
  const wrapped = [
    "set -o pipefail",
    "rc=0",
    orgCmd,
    "rc=$?",
    "printf '\\n[tmux-ui] org exited with code: %s\\n' \"$rc\"",
    "printf '[tmux-ui] You are in a shell inside the container. To detach: press Ctrl-b then d.\\n'",
    "exec bash -l"
  ].join(" ; ");

  // Full script:
  //  1) start server and ensure session exists (detached)
  //  2) respawn first pane with our wrapper
  //  3) list sessions (for debugging)
  //  4) attach to the session (blocks)
  const script = [
    "set -o pipefail",
    `${TMUX} start-server`,
    `${TMUX} has-session -t org 2>/dev/null || ${TMUX} new-session -s org -d`,
    `${TMUX} respawn-pane -k -t org.0 "bash -lc ${shq(wrapped)}"`,
    `${TMUX} ls || true`,
    `${TMUX} attach -t org`,
  ].join(" ; ");

  process.stderr.write(`[tmux-ui] session=${sessionKey} cwd=${cwd}\n`);
  process.stderr.write(`[tmux-ui] reexec: ${orgCmd}\n`);

  const run = await shInteractive(`bash -lc ${shq(script)}`, {
    projectDir: cwd,
    agentSessionId: sessionKey,
    tty: true,
    inheritStdio: true,
  });

  return run.code ?? 0;
}
