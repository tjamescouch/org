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
  const bash = [
    "set -Eeuo pipefail",
    "umask 0002",
    'mkdir -p /work/.org/logs',
    '',
    // Write tmux.conf (pure tmux syntax)
    "cat > /work/.org/tmux.conf <<'EOF_TMUX_CONF'",
    conf.trimEnd(),
    "EOF_TMUX_CONF",
    '',
    // Write the inner runner
    "cat > /work/.org/tmux-inner.sh <<'EOF_INNER'",
    inner.trimEnd(),
    "EOF_INNER",
    "chmod +x /work/.org/tmux-inner.sh",
    '',
    // Run tmux with that config. Use a dedicated socket label so parallel runs don't collide.
    `exec ${tmuxBin()} -vv -L tmux-0 -f /work/.org/tmux.conf new-session -A -s org /work/.org/tmux-inner.sh`,
  ].join("\n");

  const { code } = await shInteractive(["bash", "-lc", bash], {
    projectDir,
    agentSessionId,
  });

  return code ?? 0;
}
