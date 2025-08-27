// src/ui/tmux/index.ts
import { spawnSync } from "node:child_process";
import { tmuxAvailable } from "./doctor";

export async function launchTmuxUI(argv: string[]): Promise<number> {
  // If we’re already inside tmux (or already re-exec’d), just continue.
  if (process.env.TMUX || process.env.ORG_TMUX === "1") return 0;

  if (!tmuxAvailable()) {
    // This is the only time we should show the banner
    console.error("tmux is not installed. Install with `apt-get install tmux` (Debian/Ubuntu) or `brew install tmux` (macOS).");
    return 1;
  }

  // Re-exec inside tmux. We export ORG_TMUX=1 to avoid recursion on re-entry.
  const cmd = [
    "tmux", "new-session", "-A", "-D", "-s", "org",
    "bash", "-lc",
    `export ORG_TMUX=1; exec ${argv.map(a => JSON.stringify(a)).join(" ")}`
  ];
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  return r.status ?? 0;
}
