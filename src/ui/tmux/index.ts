// src/ui/tmux/index.ts
import { spawnSync } from "node:child_process";
import type { TmuxScope } from "../../cli/doctor";

// From your sandbox layer; adapt names if needed.
import { shInteractive, shCapture } from "../../tools/sandboxed-sh";
import { R } from "../../runtime/runtime";

/**
 * Launch org inside a tmux session.
 * - scope 'host': run the host's tmux
 * - scope 'container': run tmux inside the sandbox (container/VM)
 */
export async function launchTmuxUI(argv: string[], scope: TmuxScope): Promise<number> {
    // Avoid recursion if we're already inside tmux or after re-exec.
    if (process.env.TMUX || process.env.ORG_TMUX === "1") return 0;

    const payload = `export ORG_TMUX=1; exec ${argv.map(a => JSON.stringify(a)).join(" ")}`;
    const tmuxArgs = ["new-session", "-A", "-D", "-s", "org", "bash", "-lc", payload];

    if (scope === "host") {
        const r = spawnSync("tmux", tmuxArgs, { stdio: "inherit" });
        return r.status ?? 0;
    }

    // container/VM path: use sandbox shell with a TTY and inherited stdio
    // (so tmux can control the terminal)
    const check = await shCapture("bash -lc 'command -v tmux'", {
        agentSessionId: 'tmux-ui',
        projectDir: R.cwd()
    });
    if (check.code !== 0) {
        // bubble up a readable error — your caller can decide what to show
        process.stderr.write("tmux not found inside the sandbox. Install it in the image.\n");
        return 1;
    }

    const r = await shInteractive(["tmux", ...tmuxArgs], {
        tty: true,          // allocate TTY inside sandbox
        inheritStdio: true, // hook container stdio to the user's terminal
    });
    return r.code ?? 0;
}
