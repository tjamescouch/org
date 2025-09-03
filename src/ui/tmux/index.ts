// src/ui/tmux/index.ts
/* tmux UI launcher — simple, robust, no backslash soup */

import * as fs from "fs";
import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";

type Scope = "container" | "host";

function insideContainer(): boolean {
  if (process.env.ORG_SANDBOX_BACKEND === "none") return true;
  try { if (fs.existsSync("/run/.containerenv")) return true; } catch {}
  return false;
}

function resolveProjectDir(): string {
  if (insideContainer()) {
    try { if (fs.existsSync("/work")) return "/work"; } catch {}
  }
  return process.env.ORG_PROJECT_DIR || process.cwd();
}

export async function launchTmuxUI(argv: string[], scope: Scope = "container"): Promise<number> {
  const projectDir = resolveProjectDir();
  const agentSessionId = process.env.ORG_AGENT_SESSION_ID ?? "default";
  const entry = "/work/src/app.ts";

  Logger.info("[org/tmux] launcher start", {
    projectDir,
    agentSessionId,
    entry,
  });

  const rc = await doctorTmux(scope, projectDir, agentSessionId);
  Logger.info("[org/tmux] tmux check (interactive rc)", { code: rc });
  if (rc !== 0) {
    throw new Error("tmux not found in the sandbox image. Please add tmux to the image used for the sandbox.");
  }

  const tmuxScript = [
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    "mkdir -p /work/.org/logs/tmux-logs",
    "",
    "cat > /work/.org/tmux-inner.sh <<'EOS'",
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    "export TERM=xterm-256color",
    "export LANG=en_US.UTF-8",
    "export ORG_TMUX=1",
    "",
    'BUN="/usr/local/bin/bun"',
    'if ! command -v "$BUN" >/dev/null 2>&1; then',
    "  if command -v bun >/dev/null 2>&1; then",
    '    BUN="$(command -v bun)"',
    "  elif [ -x /home/ollama/.bun/bin/bun ]; then",
    '    BUN="/home/ollama/.bun/bin/bun"',
    "  elif [ -x /root/.bun/bin/bun ]; then",
    '    BUN="/root/.bun/bin/bun"',
    "  fi",
    "fi",
    "",
    'if [ -z "${BUN:-}" ] || [ ! -x "$BUN" ]; then',
    '  echo "[tmux-inner] bun not found" >&2',
    "  exit 127",
    "fi",
    "",
    "cd /work",
    'exec "$BUN" /work/src/app.ts --ui console',
    "EOS",
    "",
    "chmod +x /work/.org/tmux-inner.sh",
    "",
    "export TMUX_TMPDIR=/work/.org/logs/tmux-logs",
    "",
    "exec /usr/bin/tmux -vv new-session -A -s org /work/.org/tmux-inner.sh",
  ].join("\n");

  const { code } = await shInteractive(tmuxScript, {
    projectDir,
    agentSessionId,
  });

  return code ?? 0;
}

async function doctorTmux(
  _scope: Scope,
  projectDir: string,
  agentSessionId: string
): Promise<number> {
  const { code } = await shInteractive(
    "command -v tmux >/dev/null 2>&1",
    { projectDir, agentSessionId },
  );
  return code ?? 127;
}
