/* tmux UI launcher — simple, robust, no backslash soup */

import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";

type Scope = "container" | "host";

/**
 * Launch the tmux UI inside the sandbox.
 * - Writes a tiny /work/.org/tmux-inner.sh via here-doc (no escaping games).
 * - Ensures tmux exists (doctorTmux).
 * - Starts (or reuses) a session in the background, then attaches.
 * - Uses a stable bun path (/usr/local/bin/bun) with sensible fallbacks.
 */
export async function launchTmuxUI(argv: string[], scope: Scope = "container"): Promise<number> {
  // IMPORTANT: when running inside the container we want /work
  // (ORG_PROJECT_DIR is set by the outer launcher).
  const projectDir = process.env.ORG_PROJECT_DIR ?? "/work";
  const agentSessionId = process.env.ORG_AGENT_SESSION_ID ?? "default";

  const entry = "/work/src/app.ts";
  const tmuxBin = "/usr/bin/tmux";
  const logDir = "/work/.org/logs/tmux-logs";
  const socketName = "org";             // private socket name
  const sessionName = "org";            // tmux session name
  const innerScript = "/work/.org/tmux-inner.sh";

  Logger.info("[org/tmux] launcher start", {
    projectDir,
    agentSessionId,
    entry,
  });

  // doctor: make sure tmux is available where we're about to run it
  const rc = await doctorTmux(scope, projectDir, agentSessionId);
  Logger.info("[org/tmux] tmux check (interactive rc)", { code: rc });
  if (rc !== 0) {
    throw new Error(
      "tmux not found in the sandbox image. Please add tmux to the image used for the sandbox.",
    );
  }

  // Build the script without template literals so ${…} stays literal bash.
  // Pattern:
  //   1) write /work/.org/tmux-inner.sh (exec bun ... --ui console)
  //   2) export TMUX_TMPDIR + use a private socket (-L org)
  //   3) if session exists -> attach; else create -d then attach
  const tmuxScript = [
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    `mkdir -p ${logDir}`,
    "",
    "cat > /work/.org/tmux-inner.sh <<'EOS'",
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    "export TERM=xterm-256color",
    "export LANG=en_US.UTF-8",
    "",
    'BUN=\"/usr/local/bin/bun\"',
    'if ! command -v \"$BUN\" >/dev/null 2>&1; then',
    "  if command -v bun >/dev/null 2>&1; then",
    '    BUN=\"$(command -v bun)\"',
    "  elif [ -x /home/ollama/.bun/bin/bun ]; then",
    '    BUN=\"/home/ollama/.bun/bin/bun\"',
    "  elif [ -x /root/.bun/bin/bun ]; then",
    '    BUN=\"/root/.bun/bin/bun\"',
    "  fi",
    "fi",
    "",
    'if [ -z \"${BUN:-}\" ] || [ ! -x \"$BUN\" ]; then',
    '  echo \"[tmux-inner] bun not found\" >&2',
    "  exit 127",
    "fi",
    "",
    "cd /work",
    'exec \"$BUN\" /work/src/app.ts --ui console',
    "EOS",
    "",
    "chmod +x /work/.org/tmux-inner.sh",
    "",
    // Tell tmux where to put its logs/sockets and use a private socket name
    `export TMUX_TMPDIR=${logDir}`,
    "",
    // If session already exists, just attach. Otherwise create detached, then attach.
    `if ${tmuxBin} -L ${socketName} has-session -t ${sessionName} 2>/dev/null; then`,
    `  exec ${tmuxBin} -L ${socketName} attach -t ${sessionName}`,
    "else",
    `  ${tmuxBin} -vv -L ${socketName} new-session -d -s ${sessionName} ${innerScript} >>${logDir}/tmux-server.log 2>&1 || true`,
    `  exec ${tmuxBin} -L ${socketName} attach -t ${sessionName}`,
    "fi",
  ].join("\n");

  // Execute interactively inside the sandbox — preserves TTY and keeps tmux attached.
  const { code } = await shInteractive(["bash", "-lc", tmuxScript], {
    projectDir,
    agentSessionId,
  });

  return code ?? 0;
}

/**
 * Minimal tmux presence check where we're about to run it.
 * IMPORTANT: use interactive exec (capture is not implemented in Podman session).
 */
async function doctorTmux(
  _scope: Scope,
  projectDir: string,
  agentSessionId: string
): Promise<number> {
  // We only care about an exit status; suppress output
  const { code } = await shInteractive(
    ['bash', '-lc', 'command -v tmux >/dev/null 2>&1'],
    { projectDir, agentSessionId },
  );
  return code ?? 127;
}
