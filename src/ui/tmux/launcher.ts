// src/ui/tmux/launcher.ts
// Minimal, target-safe tmux launcher with robust logging and a sticky session
// so the pane doesn't vanish when the inner program exits.

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { spawnSync } from "child_process";
import { Logger } from "../../logger";
import { R } from "../../runtime/runtime";
import { shInteractive } from "../../tools/sandboxed-sh";

export type LaunchTmuxUIOpts = {
  /** Full argv to (re)run the org CLI inside tmux (we'll rewrite this to `--ui console`). */
  argv: string[];
  /** Optional explicit cwd for the tmux session. Defaults to /work inside the container. */
  cwd?: string;
  /** Extra env to add; merged over process.env. */
  env?: NodeJS.ProcessEnv;
  /** Force a session name (default: "org"). */
  sessionName?: string;
};

/* ------------------------------ small helpers ------------------------------ */

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function which(cmd: string): string | null {
  const r = spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function ensureDir(p: string) {
  await fsp.mkdir(p, { recursive: true });
}

function nowISO() {
  return new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
}

/* ------------------------------ tmux launcher ------------------------------ */

export async function launchTmuxUI(opts: LaunchTmuxUIOpts): Promise<number> {
  const tmuxPath = which("tmux");
  if (!tmuxPath) {
    Logger.error("tmux is not installed. Please install tmux inside the image.");
    return 127;
  }

  // Where we write bits the inner script and logs expect.
  const projectDir = process.env.ORG_PROJECT_DIR || "/work";
  const runRoot = path.posix.join(projectDir, ".org");
  const logsDir = path.posix.join(runRoot, "logs");
  const tmuxLogs = path.posix.join(logsDir, "tmux-logs");
  const innerPath = path.posix.join(runRoot, "tmux-inner.sh");

  await ensureDir(tmuxLogs);

  // Record a lightweight launcher log (plain text, easy to tail).
  const stamp = nowISO();
  const launchLog = path.posix.join(logsDir, `tmux-launcher-${stamp}.log`);
  const log = async (line: string) => {
    try {
      await fsp.appendFile(launchLog, `[tmux/launcher] ${line}\n`, "utf8");
    } catch {
      /* ignore */
    }
  };

  const sessionName = (opts.sessionName || "org").trim();
  const sockLabel = "tmux-0"; // stable label per-process; single sandbox session

  // We always run the *console* UI inside tmux.
  // Reconstruct `bun /work/src/app.ts --ui console` from argv.
  const argv = [...opts.argv];
  const uiIdx = argv.findIndex((a) => a === "--ui");
  if (uiIdx >= 0 && argv.length > uiIdx + 1) {
    argv[uiIdx + 1] = "console";
  } else {
    argv.push("--ui", "console");
  }

  const childCmd = argv.map(shq).join(" ");

  await log(`begin ${new Date().toISOString()}`);
  await log(`tmux version: ${spawnSync(tmuxPath, ["-V"], { encoding: "utf8" }).stdout.trim()}`);
  await log(`socket label: ${sockLabel}`);
  await log(`projectDir: ${projectDir}`);
  await log(`argv: ${childCmd}`);

  // Compose a here‑doc script we run *interactively inside the sandbox*.
  // This avoids backslash soup, and keeps everything together for reproduction.
  const script = [
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    `export TMUX_LOG_DIR=${shq(tmuxLogs)}`,
    `export TMUX_SOCK_LABEL=${shq(sockLabel)}`,
    `export SESSION=${shq(sessionName)}`,
    `export INNER=${shq(innerPath)}`,
    `export ORG_PROJECT_DIR=${shq(projectDir)}`,
    "",
    // Prepare logs and inner script (print a tiny env header once for forensics)
    "mkdir -p \"$TMUX_LOG_DIR\"",
    "mkdir -p \"$(dirname \"$INNER\")\"",
    "",
    "cat > \"$INNER\" <<'EOS_INNER'",
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    // helpful one-shot environment banner at pane top
    "echo \"SHELL:  $SHELL\"",
    "echo \"TERM_PROGRAM_VERSION: ${TERM_PROGRAM_VERSION-}\"",
    "echo \"TMUX:   ${TMUX-}\"",
    "echo \"HOSTNAME: $HOSTNAME\"",
    "echo \"PWD: $PWD\"",
    "echo",
    "",
    // robust bun discovery
    "BUN=\"/usr/local/bin/bun\"",
    "if ! command -v \"$BUN\" >/dev/null 2>&1; then",
    "  if command -v bun >/dev/null 2>&1; then BUN=\"$(command -v bun)\";",
    "  elif [ -x /home/ollama/.bun/bin/bun ]; then BUN=/home/ollama/.bun/bin/bun;",
    "  elif [ -x /root/.bun/bin/bun ]; then BUN=/root/.bun/bin/bun;",
    "  fi",
    "fi",
    "if [ -z \"${BUN:-}\" ] || [ ! -x \"$BUN\" ]; then",
    "  echo \"[tmux-inner] bun not found\" >&2; exit 127;",
    "fi",
    "",
    "cd \"$ORG_PROJECT_DIR\"",
    // IMPORTANT: run *console* UI inside tmux
    `exec ${shq("/usr/bin/env")} -i PATH=\"$PATH\" HOME=\"$HOME\" TERM=\"$TERM\" LC_ALL=\"$LC_ALL\" LANG=\"$LANG\" \"$BUN\" /work/src/app.ts --ui console`,
    "EOS_INNER",
    "chmod +x \"$INNER\"",
    "",
    // Bring up a *clean* server and set only global options first
    "tmux -vv -L \"$TMUX_SOCK_LABEL\" start-server",
    // Do not let the server die under the client while debugging
    "tmux -vv -L \"$TMUX_SOCK_LABEL\" set -g exit-empty off >/dev/null 2>&1 || true",
    "tmux -vv -L \"$TMUX_SOCK_LABEL\" set -g exit-unattached off >/dev/null 2>&1 || true",
    "tmux -vv -L \"$TMUX_SOCK_LABEL\" set -g remain-on-exit on >/dev/null 2>&1 || true",
    // keep interactions snappy and enable mouse, but avoid any target-dependent commands
    "tmux -vv -L \"$TMUX_SOCK_LABEL\" set -g escape-time 0 >/dev/null 2>&1 || true",
    "tmux -vv -L \"$TMUX_SOCK_LABEL\" set -g status-interval 5 >/dev/null 2>&1 || true",
    "tmux -vv -L \"$TMUX_SOCK_LABEL\" set -g mouse on >/dev/null 2>&1 || true",
    "",
    // Create the session if missing, with a *fixed* cwd and the inner script as program
    "if ! tmux -L \"$TMUX_SOCK_LABEL\" has-session -t \"$SESSION\" 2>/dev/null; then",
    "  tmux -vv -L \"$TMUX_SOCK_LABEL\" new-session -ds \"$SESSION\" -c \"$ORG_PROJECT_DIR\" -n org \"$INNER\"",
    "fi",
    // And attach
    "exec tmux -vv -L \"$TMUX_SOCK_LABEL\" attach -t \"$SESSION\"",
  ].join("\n");

  // Run interactively inside the sandbox.
  const { code } = await shInteractive(["bash", "-lc", script], {
    projectDir,
    agentSessionId: "default",
  });

  await log(`end ${new Date().toISOString()} rc=${code ?? 0}`);
  return code ?? 0;
}
