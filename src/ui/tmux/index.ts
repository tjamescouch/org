// src/ui/tmux/index.ts
import { shCapture, shInteractive, currentSandboxSessionKey } from "../../tools/sandboxed-sh";

const shq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Pull first agent id from  --agents "<id>:kind,..."
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
 * Launch the tmux UI inside the sandbox.
 * - No early return on process.env.TMUX (we *want* to attach regardless).
 * - Uses a dedicated tmux server socket to avoid “no sessions”.
 * - Respawns pane with inner `org` (without `--ui tmux`) and attaches.
 * - Keeps the pane alive; prints exit code then drops to a shell.
 */
export async function launchTmuxUI(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const sessionKey =
    process.env.ORG_TMUX_SESSION ||
    currentSandboxSessionKey() ||
    firstAgentIdFromArgv(argv);

  // Ensure sandbox exists (creates container if needed)
  await shCapture("true", { projectDir: cwd, agentSessionId: sessionKey });

  // tmux availability inside the sandbox
  const check = await shCapture("command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1", {
    projectDir: cwd,
    agentSessionId: sessionKey,
  });
  if (check.code !== 0) {
    process.stderr.write(`[tmux-ui] tmux not found in sandbox session "${sessionKey}".\n`);
    return 1;
  }

  // Build inner argv: re-run org WITHOUT the UI flag to avoid recursion
  const innerArgs = argv.filter((a, i, arr) => !(a === "--ui" || (a === "tmux" && arr[i - 1] === "--ui")));
  const orgCmd =
    `LOG_LEVEL=${process.env.LOG_LEVEL ?? "INFO"} DEBUG=${process.env.DEBUG ?? ""} ` +
    `org ${innerArgs.map(shq).join(" ")}`;

  // Use a dedicated socket so all tmux commands hit the same server
  const TMUX = "tmux -L orgsrv";

  // Wrapper keeps the pane alive after org exits, prints exit code, then starts a shell
  const wrapped = [
    "set -o pipefail",
    "rc=0",
    orgCmd,
    "rc=$?",
    "printf '\\n[tmux-ui] org exited with code: %s\\n' \"$rc\"",
    "printf '[tmux-ui] You are in a shell inside the container. Detach: Ctrl-b then d.\\n'",
    "exec bash -l"
  ].join(" ; ");

  const script = [
    "set -o pipefail",
    `${TMUX} start-server`,
    `${TMUX} has-session -t org 2>/dev/null || ${TMUX} new-session -s org -d`,
    `${TMUX} respawn-pane -k -t org.0 "bash -lc ${shq(wrapped)}"`,
    `${TMUX} ls || true`,
    `${TMUX} attach -t org`,
  ].join(" ; ");

  process.stderr.write(`[tmux-ui] session=${sessionKey} cwd=${cwd}\n`);
  process.stderr.write(`[tmux-ui] exec script via sandbox…\n`);

  const run = await shInteractive(`bash -lc ${shq(script)}`, {
    projectDir: cwd,
    agentSessionId: sessionKey,
    tty: true,
    inheritStdio: true,
  });

  return run.code ?? 0;
}
