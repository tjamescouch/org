// src/ui/tmux/launcher.ts
//
// Ephemeral tmux launcher used by the /ui/tmux entry.
// - writes an ephemeral conf (no target-dependent lines) via buildEphemeralTmuxConf()
// - creates a private tmux server/socket and a detached session
// - attaches to the session
// - passes curated env (same policy we use for sandbox backends)
// - puts tmux -vv logs under a temp TMUX_TMPDIR so we can inspect failures

import * as os from "os";
import * as path from "path";
import * as fsp from "fs/promises";
import { spawnSync, spawn } from "child_process";
import { Logger } from "../../logger";
import { R } from "../../runtime/runtime";
import { buildEphemeralTmuxConf } from "./config";
import { envToPodmanArgs } from "../../runtime/env-forward";

export type LaunchTmuxUIOpts = {
  argv: string[];              // the app argv to re-run inside tmux
  cwd?: string;
  env?: NodeJS.ProcessEnv;     // merged over process.env
  allowNested?: boolean;       // if inside tmux already, create-window
  sessionName?: string;        // default "org"
};

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function which(cmd: string): string | null {
  const r = spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function writeFile(p: string, body: string) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, body, "utf8");
}

/** Convert curated env (same policy as podman) into a shell prefix KEY='v' KEY2='v' … */
function buildEnvPrefix(env: NodeJS.ProcessEnv): string {
  const args = envToPodmanArgs(env); // ["-e","K=V","-e","A=B", ...]
  const kv: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-e") continue;
    const pair = args[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const k = pair.slice(0, eq);
      const v = pair.slice(eq + 1);
      kv.push(`${k}=${shq(v)}`);
    }
    i++; // consume the value we just read
  }
  return kv.join(" ");
}

export async function launchTmuxUI(opts: LaunchTmuxUIOpts): Promise<number> {
  const tmux = which("tmux");
  if (!tmux) {
    Logger.error("tmux is not installed inside the image (required for --ui tmux).");
    return 127;
  }

  const cwd = opts.cwd ?? process.cwd();
  const env = { ...process.env, ...(opts.env || {}), ORG_TMUX: "1" };
  const sessionName = opts.sessionName || "org";

  // Build the “inner” command to run the app with --ui console
  const argv = [...opts.argv];
  const uiIdx = argv.findIndex((a) => a === "--ui");
  if (uiIdx >= 0 && argv.length > uiIdx + 1) {
    argv[uiIdx + 1] = "console";
  } else {
    argv.push("--ui", "console");
  }
  const childCmd = argv.map(shq).join(" ");

  // Nested tmux? (Allow SRE folks to run tmux-inside-tmux if needed)
  if (process.env.TMUX && (opts.allowNested ?? true)) {
    const inner = (buildEnvPrefix(env) ? `${buildEnvPrefix(env)} ` : "") + childCmd;
    const winName = sessionName;
    const cmd = `tmux new-window -n ${shq(winName)} "bash -lc ${shq(inner)}"`;
    const r = spawnSync("bash", ["-lc", cmd], { cwd, env, stdio: "inherit" });
    return r.status ?? 0;
  }

  // Ephemeral conf on disk
  const conf = buildEphemeralTmuxConf({ mouse: true });
  const confPath = path.join(os.tmpdir(), `org-tmux-${process.pid}-${Date.now()}`, "tmux.conf");
  await writeFile(confPath, conf);

  // Private socket name & tmux tmpdir (where -vv logs and sockets get placed)
  const sockLabel = `org-${process.pid}`;
  const tmuxTmp = path.join(os.tmpdir(), "org-tmux-logs");
  await fsp.mkdir(tmuxTmp, { recursive: true });

  // new-session (detached) then attach; pass child env via a prefix
  const envPrefix = buildEnvPrefix(env);
  const inner = envPrefix ? `${envPrefix} ${childCmd}` : childCmd;

  const newSession =
    `TMUX_TMPDIR=${shq(tmuxTmp)} ` +
    `${tmux} -vv -L ${shq(sockLabel)} -f ${shq(confPath)} ` +
    `new-session -d -s ${shq(sessionName)} -n main "bash -lc ${shq(inner)}"`;

  const attach =
    `TMUX_TMPDIR=${shq(tmuxTmp)} ` +
    `${tmux} -L ${shq(sockLabel)} attach -t ${shq(sessionName)}`;

  // Run new-session; bail early with the same non-zero rc if it fails
  {
    const r = spawnSync("bash", ["-lc", newSession], { cwd, env, stdio: "inherit" });
    if ((r.status ?? 0) !== 0) {
      Logger.error("[tmux/launcher] new-session failed");
      return r.status ?? 1;
    }
  }

  // Attach (keeps the user in tmux; returns on detach/exit)
  const child = spawn("bash", ["-lc", attach], { cwd, env, stdio: "inherit" });
  const rc: number = await new Promise((resolve) => {
    child.on("close", (c) => resolve(c ?? 0));
    child.on("exit",  (c) => resolve(c ?? 0));
  });

  // Best-effort: kill the session; ignore errors
  spawnSync("bash", ["-lc", `TMUX_TMPDIR=${shq(tmuxTmp)} ${tmux} -L ${shq(sockLabel)} kill-session -t ${shq(sessionName)} >/dev/null 2>&1 || true`], {
    cwd,
    env,
    stdio: "ignore",
  });

  return rc;
}
