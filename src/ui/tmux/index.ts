/* tmux UI launcher — safe pre-session config + inner wrapper with logs */

import { Logger } from "../../logger";
import { shInteractive } from "../../tools/sandboxed-sh";

type Scope = "container" | "host";

/** Minimal, safe tmux.conf that can be loaded before any session exists. */
function buildSafeTmuxConf(): string {
  return [
    // stay conservative; only server/global scope here
    'set -s escape-time 0',
    'set -g mouse on',
    'set -g status on',
    'set -g status-interval 2',
    // keep server and session alive even if a pane exits
    'set -g remain-on-exit on',
    'set -g detach-on-destroy off',
    'set -s exit-empty off',
    // keep colors sane
    'set -g default-terminal "tmux-256color"',
    // modern truecolor, but do not explode if term db is older
    'set -as terminal-overrides ",xterm-256color:Tc,tmux-256color:Tc"',
    // focus events help some UIs, harmless otherwise
    'set -g focus-events on',
    // quiet any benign warnings (we’ll log ourselves)
    'set -s quiet on',
  ].join("\n") + "\n";
}

/** Produce /work/.org/tmux-inner.sh; the child program runs *inside* the pane. */
function buildInnerScript(entryCmd: string): string {
  // We keep everything extremely portable; no target-dependent tmux here.
  const result = [
    "#!/usr/bin/env bash",
    "set -v",
    "set -Eeuo pipefail",
    "umask 0002",
    "",
    'LOG_DIR="/work/.org/logs"',
    'mkdir -p \"$LOG_DIR\" \"$LOG_DIR/tmux-logs\"',
    'ENV_LOG=\"$LOG_DIR/tmux-inner.env\"',
    'RUN_LOG=\"$LOG_DIR/tmux-inner.log\"',
    'TYPE_LOG=\"$LOG_DIR/tmux-typescript.log\"',
    "",
    // Log environment (helps verify env propagation / TERM etc.)
    "{",
    "  echo \"[tmux-inner] start $(date -Is)\"",
    "  echo \"[tmux-inner] cwd: $(pwd) user=$(id -u):$(id -g)\"",
    "  echo \"[tmux-inner] env:\"",
    "  env | sort",
    "} | tee \"$ENV_LOG\" >/dev/null",
    "",
    // Find bun if not forced by the entry command (we still allow override)
    'BUN_CANDIDATES=("/usr/local/bin/bun" "$(command -v bun || true)" "/home/ollama/.bun/bin/bun" "/root/.bun/bin/bun")',
    'if [[ "$entryCmd" == *"/work/src/app.ts"* || "$entryCmd" == *"--ui "* ]]; then',
    "  : # likely our app; try to locate bun when entryCmd uses it implicitly",
    "fi",
    "",
    // If `script` is present we can capture a typescript without breaking TTY
    "use_script=0",
    "if command -v script >/dev/null 2>&1; then",
    "  use_script=1",
    "fi",
    "",
    // Clean exit logging
    "on_exit() {",
    "  ec=$?",
    "  echo \"[tmux-inner] exit $(date -Is) code=${ec}\" | tee -a \"$RUN_LOG\" >/dev/null",
    "}",
    "trap on_exit EXIT",
    "",
    // Prefer to *exec* the child so its signals are not double-handled.
    // If script is available, use it to record a typescript without losing the PTY.
    "if [[ $use_script -eq 1 ]]; then",
    "  # util-linux `script` keeps a pty; -q quiet, -f flush often, -e return child status",
    "  # NOTE: do not pipe; keep the child attached to a TTY",
    `  exec script -qfe -c ${shq(entryCmd)} \"$TYPE_LOG\"`,
    "else",
    `  exec ${shq(entryCmd)}`,
    "fi",
    "",
  ].join("\n").replaceAll("\$entryCmd", entryCmd);

  Logger.info("TMUX INNER", result);

  return "echo DONE";
}

/** Single-quote shell quoting for literals used in bash -lc. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Launch the tmux UI inside the sandbox.
 * - Writes a safe /work/.org/tmux.conf (only server/global options).
 * - Writes /work/.org/tmux-inner.sh to run the child and logs exit/env.
 * - Starts a private server (-L tmux-0) and attaches to session "org".
 *
 * Set ORG_TMUX_ENTRY to override the program started inside tmux (e.g., /bin/bash)
 * to isolate whether tmux or the app is exiting.
 */
export async function launchTmuxUI(argv: string[], _scope: Scope = "container"): Promise<number> {
  const projectDir = process.env.ORG_PROJECT_DIR ?? process.cwd();
  const agentSessionId = process.env.ORG_AGENT_SESSION_ID ?? "default";

  // Default entry: our app
  const defaultEntry = "/usr/local/bin/bun /work/src/app.ts --ui console";
  const entry = process.env.ORG_TMUX_ENTRY && process.env.ORG_TMUX_ENTRY.trim().length > 0
    ? process.env.ORG_TMUX_ENTRY
    : defaultEntry;

  const conf = buildSafeTmuxConf();
  const inner = buildInnerScript(entry);

  Logger.info("[org/tmux] launcher start", {
    projectDir,
    agentSessionId,
    entry,
  });

  // 1) Write files (here-doc via interactive exec to keep quoting sane)
  const writeFiles = [
    // tmux.conf
    "cat > /work/.org/tmux.conf <<'EOF_TMUX_CONF'\n" + conf + "\n'EOF_TMUX_CONF'\n",
    // tmux-inner.sh
    "cat > /work/.org/tmux-inner.sh <<'EOF_INNER'\n" + inner + "\n'EOF_INNER'\n",
    "chmod +x /work/.org/tmux-inner.sh",
  ].join("\n");

  {
    Logger.info("[org/mux] writeFiles", writeFiles)
    const { code } = await shInteractive(["bash", "-lc", writeFiles], {
      projectDir,
      agentSessionId,
    });
    if (code !== 0) return code ?? 1;
  }

  // 2) Start server + new-session (detached) and attach
  // Use a private socket namespace (-L tmux-0) to avoid collisions.
  const cmd =
    [
      // diagnose: print a small banner to the app log as well
      `echo "[tmux/launcher] begin $(date -Is)" | tee -a /work/.org/logs/tmux-launcher.log >/dev/null`,
      `tmux -V | sed 's/^/[tmux\\/launcher] tmux version: /' | tee -a /work/.org/logs/tmux-launcher.log >/dev/null`,
      `echo "[tmux/launcher] socket label: tmux-0" | tee -a /work/.org/logs/tmux-launcher.log >/dev/null`,
      `echo "[tmux/launcher] conf: /work/.org/tmux.conf" | tee -a /work/.org/logs/tmux-launcher.log >/dev/null`,
      `echo "[tmux/launcher] conf: $(cat /work/.org/tmux.conf)`,
      `echo "[tmux/launcher] inner: /work/.org/tmux-inner.sh" | tee -a /work/.org/logs/tmux-launcher.log >/dev/null`,

      // start a server (no-op if already up), then create/replace session
      // -d: detached, -s org: session name, -n main: window name
      // We call inner via bash -lc so PATH/ENV behave the same as our app.
      `tmux -L tmux-0 -f /work/.org/tmux.conf new-session -d -s org -n main "bash -lc /work/.org/tmux-inner.sh"`,

      // attach (when this returns, the client has detached or the session closed)
      `tmux -L tmux-0 attach -t org`,

      // mark the end in the launcher log
      `echo "[tmux/launcher] end $(date -Is)" | tee -a /work/.org/logs/tmux-launcher.log >/dev/null`,
    ].join(" && ");
  Logger.info("[org/mux] cmd", cmd);

  const { code } = await shInteractive(["bash", "-lcv", cmd], {
    projectDir,
    agentSessionId,
  });
  Logger.info("[org/mux] exit code", code);

  return code ?? 0;
}
