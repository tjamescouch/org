import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";
import { buildTmuxConf, buildInnerScript } from "./config";

type Scope = "container" | "host";

function tmuxBin(): string {
  return process.env.ORG_TMUX_BIN || "/usr/bin/tmux";
}

async function doctorTmux(projectDir: string, agentSessionId: string): Promise<number> {
  const { code } = await shInteractive(['bash', '-lc', 'command -v ' + tmuxBin() + ' >/dev/null 2>&1'], {
    projectDir,
    agentSessionId,
  });
  return code ?? 127;
}

export async function launchTmuxUI(argv: string[], _scope: Scope = "container"): Promise<number> {
  // Always operate on the sandbox path
  const projectDir = "/work";
  const agentSessionId = process.env.ORG_AGENT_SESSION_ID ?? "default";

  // Your app entry (we always execute via bun inside the pane)
  const entry = "/work/src/app.ts";
  const entryCmd = `/usr/local/bin/bun ${entry} --ui console`;

  Logger.info("[org/tmux] launcher start", { projectDir, agentSessionId, entry });

  // Quick presence check
  const rc = await doctorTmux(projectDir, agentSessionId);
  Logger.info("[org/tmux] tmux check (interactive rc)", { code: rc });
  if (rc !== 0) {
    throw new Error("tmux not found in the sandbox image. Please add tmux to the image used for the sandbox.");
  }

  // Build artifacts
  const conf = buildTmuxConf();
  const inner = buildInnerScript(entryCmd);

  // Write both files with separate, *quoted* here-docs and start tmux
  const tmuxScript = [
    // --- write tmux.conf ---
    "mkdir -p /work/.org/logs /work/.org/tmp",
    "cat > /work/.org/tmux.conf <<'EOF_TMUX_CONF'",
    'set -s exit-empty off',
    'set -g default-terminal "tmux-256color"',
    'set -as terminal-overrides ",xterm-256color:Tc,tmux-256color:Tc"',
    'set -g focus-events on',
    'set -s quiet on',
    "EOF_TMUX_CONF",                 // <-- terminator must be alone

    // --- write tmux-inner.sh ---
    "cat > /work/.org/tmux-inner.sh <<'EOF_INNER'",
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "umask 0002",
    "exec </dev/tty >/dev/tty 2>&1",
    "export TERM=xterm-256color LANG=en_US.UTF-8",
    'BUN="/usr/local/bin/bun"; command -v "$BUN" >/dev/null 2>&1 || BUN="$(command -v bun || true)" || BUN="/home/ollama/.bun/bin/bun"',
    "cd /work",
    'exec "$BUN" /work/src/app.ts --ui console',
    "EOF_INNER",                     // <-- terminator must be alone
    "chmod +x /work/.org/tmux-inner.sh",

    // --- start tmux using that config ---
    'exec /usr/bin/tmux -vv -f /work/.org/tmux.conf new-session -A -s org /work/.org/tmux-inner.sh'
  ].join("\n");

  const { code } = await shInteractive(["bash", "-lc", tmuxScript], {
    projectDir,
    agentSessionId,
  });

  return code ?? 0;
}
