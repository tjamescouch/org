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
  const hostCwd = process.cwd();
  const sessionKey =
    process.env.ORG_TMUX_SESSION ||
    currentSandboxSessionKey() ||
    firstAgentIdFromArgv(argv);

  await shCapture("true", { projectDir: hostCwd, agentSessionId: sessionKey });

  const innerArgs = argv.filter((a, i, arr) => !(a === "--ui" || (a === "tmux" && arr[i - 1] === "--ui")));
  const innerCmd =
    `cd /work || cd "$PWD" || true; ` +
    `ORG_SESSION_DIR=/work/.org DEBUG=${process.env.DEBUG ?? ""} LOG_LEVEL=${process.env.LOG_LEVEL ?? "INFO"} ` +
    `./org ${innerArgs.map(shq).join(" ")}`;

  const TMUX = "tmux -L orgsrv";
  const wrapped = [
    "set -o pipefail",
    "rc=0",
    innerCmd,
    "rc=$?",
    "printf '\\n[tmux-ui] org exited with code: %s\\n' \"$rc\"",
    "printf '[tmux-ui] You are in a shell inside the container. Detach: Ctrl-b then d.\\n'",
    "exec bash -l",
  ].join(" ; ");

  const script = [
    "set -o pipefail",
    `${TMUX} start-server`,
    `${TMUX} has-session -t org 2>/dev/null || ${TMUX} new-session -s org -d`,
    `${TMUX} respawn-pane -k -t org.0 "bash -lc ${shq(wrapped)}"`,
    `${TMUX} attach -t org`,
  ].join(" ; ");

  process.stderr.write(`[tmux-ui] session=${sessionKey} cwd=${hostCwd}\n`);

  const run = await shInteractive(`bash -lc ${shq(script)}`, {
    projectDir: hostCwd,
    agentSessionId: sessionKey,
    tty: true,
    inheritStdio: true,
  });

  return run.code ?? 0;
}
