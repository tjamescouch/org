// src/ui/tmux/index.ts
import { spawnSync } from "node:child_process";
import { shInteractive, shCapture } from "../../tools/sandboxed-sh";
import { R } from "../../runtime/runtime";

export type TmuxScope = "host" | "container";

const TMUX_SESSION = process.env.ORG_TMUX_SESSION || "org";

export async function launchTmuxUI(argv: string[], scope: TmuxScope = "container"): Promise<number> {
  if (process.env.TMUX || process.env.ORG_TMUX === "1") return 0;

  const payload = `export ORG_TMUX=1; exec ${argv.map(a => JSON.stringify(a)).join(" ")}`;

  if (scope === "host") {
    const hostCmd =
      `tmux new-session -A -D -s ${JSON.stringify(TMUX_SESSION)} ` +
      `bash -lc ${JSON.stringify(payload)}`;
    const r = spawnSync("bash", ["-lc", hostCmd], { stdio: "inherit" });
    return r.status ?? 0;
  }

  // container / VM path
  const ctx = { agentSessionId: "tmux-ui", projectDir: R.cwd() };

  // Quiet check: returns 0 if found, non-zero if missing.
  const check = await shCapture(`bash -lc 'command -v tmux >/dev/null 2>&1'`, ctx);
  if (check.exit_code !== 0) {
    process.stderr.write("tmux not found inside the sandbox image. Please install it in the container.\n");
    return 1;
  }

  // Run tmux inside the sandbox, interactive
  const tmuxCmd =
    `tmux new-session -A -D -s ${JSON.stringify(TMUX_SESSION)} ` +
    `bash -lc ${JSON.stringify(payload)}`;

  const code = await shInteractive(tmuxCmd, ctx);
  return code;
}
