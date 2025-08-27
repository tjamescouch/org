// src/ui/tmux/index.ts
import { shCapture, shInteractive, currentSandboxSessionKey } from "../../tools/sandboxed-sh";

function shq(s: string) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

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

  // Build inner argv: run **org** without the UI flag
  const innerArgs = argv.filter((a, i, arr) => {
    if (a === "--ui") return false;
    if (a === "tmux") {
      // drop the literal "tmux" that follows --ui
      // also handle the case user typed "… --ui tmux …"
      return arr[i - 1] !== "--ui";
    }
    return true;
  });

  // Explicitly invoke the CLI entry: "org <args...>"
  const reexec =
    `LOG_LEVEL=${process.env.LOG_LEVEL ?? "INFO"} DEBUG=${process.env.DEBUG ?? ""} ` +
    `exec org ${innerArgs.map(shq).join(" ")}`;

  // Two-step: ensure session, respawn pane with org, attach
  const script = [
    "set -euo pipefail",
    "tmux has-session -t org 2>/dev/null || tmux new-session -s org -d",
    `tmux respawn-pane -k -t org.0 "bash -lc ${shq(reexec)}"`,
    "tmux attach -t org"
  ].join("; ");

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
