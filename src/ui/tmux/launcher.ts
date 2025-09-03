// src/ui/tmux/launcher.ts
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawnSync, spawn } from "child_process";
import { buildEphemeralTmuxConf } from "./config";
import { Logger } from "../../logger";
import { R } from "../../runtime/runtime";

// NEW: import the same env curation we use for podman
import { envToPodmanArgs } from "../../sandbox/utils/env-propagation";

export type LaunchTmuxUIOpts = {
  // Full argv for the program to run inside tmux
  argv: string[];             // e.g., process.argv (or a reconstructed argv)
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // If already inside tmux, open a new-window instead of a new server
  allowNested?: boolean;      // default: true
  // Optional: force a session name
  sessionName?: string;
};

function which(cmd: string): string | null {
  const out = spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  const s = out.stdout.trim();
  return out.status === 0 && s ? s : null;
}

function detectClipboardHelper(): "pbcopy" | "xclip" | "wl-copy" | null {
  if (which("pbcopy")) return "pbcopy";
  if (which("xclip")) return "xclip";
  if (which("wl-copy")) return "wl-copy";
  return null;
}

async function writeEphemeralConf(opts: { clipboard: "pbcopy" | "xclip" | "wl-copy" | null }): Promise<string> {
  const dir = path.join(os.tmpdir(), `org-tmux-${process.pid}-${Date.now()}`);
  await fsp.mkdir(dir, { recursive: true });
  const conf = buildEphemeralTmuxConf({
    hint: "prefix C-b | p: patch | m: mouse",
    clipboardHelper: opts.clipboard,
    mouse: true,
  });
  const confPath = path.join(dir, "tmux.conf");
  await fsp.writeFile(confPath, conf, "utf8");
  return confPath;
}

/** Convert curated env (same policy as podman) into an array: ["-e","KEY=VAL", ...]  */
function buildTmuxEnvArray(env: NodeJS.ProcessEnv): string[] {
  const args = envToPodmanArgs(env);
  // args look like ["-e","OPENAI_BASE_URL=...","-e","FOO=bar", ...]
  const kv: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e") {
      const pair = args[i + 1] ?? "";
      kv.push(pair);
      i++; // skip consumed value
    }
  }
  return kv;
}

/** Convert curated env into `export KEY='VAL'; export KEY2='VAL'; ...` */
function buildEnvExports(env: NodeJS.ProcessEnv): string {
  const kv = buildTmuxEnvArray(env);
  const exports: string[] = [];

  // Always mark that we are running inside tmux (the pane) so interactive
  // helpers can send keys without spawning a local shell.
  exports.push("export ORG_TMUX='1';");

  for (const pair of kv) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    exports.push(`export ${k}=${shq(v)};`);
  }

  return exports.join(" ");
}

/**
 * Launches tmux UI. Behavior:
 *  - If $TMUX is set and allowNested!=false -> create-window in current session.
 *  - Else -> start a new tmux server with a private socket (-L) & ephemeral conf, then attach.
 * The program inside tmux is the *same* org CLI, with env ORG_TMUX=1.
 *
 * NOTE: We avoid spawning an extra `bash -lc` inside the pane. Instead, we
 * run the full child command directly as the pane program with tmux. If you do
 * need a shell for any reason, switch the `inner` string below to
 * `${SHELL:-/bin/sh} -lc ${shq(inner)}`.
 */
export async function launchTmuxUI(opts: LaunchTmuxUIOpts): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const env = { ...process.env, ...(opts.env || {}), ORG_TMUX: "1" };

  // 1) Ensure tmux exists
  const tmuxPath = which("tmux");
  if (!tmuxPath) {
    Logger.error("tmux is not installed. Install with `brew install tmux` or `apt-get install tmux`.");
    return 127;
  }

  // 2) Build argv for child (the same program the user invoked)
  const childCmd = buildShellQuotedCmd(opts.argv);

  // 2b) Prepare env exports (whitelisted like podman) to inject *inside* the pane
  const envExports = buildEnvExports(env); // e.g., "export ORG_TMUX='1'; export OPENAI_BASE_URL='...'; ..."
  const inner = envExports ? `${envExports} ${childCmd}` : childCmd;

  // 3) Nested? If TMUX set and allowNested(default true) => new-window
  if (process.env.TMUX && (opts.allowNested ?? true)) {
    const winName = opts.sessionName || "org";
    // Run the full command directly as the pane program (no extra bash hop)
    const cmd = `tmux new-window -n ${shq(winName)} ${shq(inner)}`;
    const r = spawnSync("bash", ["-lc", cmd], { cwd, env, stdio: "inherit" });
    return r.status ?? 0;
  }

  // 4) New server with private socket + ephemeral conf
  const clipboardHelper = detectClipboardHelper();
  const confPath = await writeEphemeralConf({ clipboard: clipboardHelper });
  const sockName = `org-${process.pid}-${Date.now()}`;
  const sessionName = opts.sessionName || "org";

  // start detached: run the full command directly in the pane
  {
    const newSessionCmd =
      `tmux -L ${shq(sockName)} -f ${shq(confPath)} ` +
      `new-session -d -s ${shq(sessionName)} -n main ${shq(inner)}`;

    const r = spawnSync(`bash`, ["-lc", newSessionCmd], { cwd, env, stdio: "inherit" });
    if (r.status !== 0) return r.status ?? 1;
  }

  // attach
  const attach = spawn(`bash`, ["-lc", `tmux -L ${shq(sockName)} attach -t ${shq(sessionName)}`], {
    cwd,
    env,
    stdio: "inherit",
  });

  return await new Promise<number>((resolve) => {
    attach.on("exit", async (code) => {
      // Best-effort cleanup: kill session; ignore errors (user may have killed already)
      spawnSync(
        "bash",
        ["-lc", `tmux -L ${shq(sockName)} kill-session -t ${shq(sessionName)} >/dev/null 2>&1 || true`],
        { cwd, env, stdio: "ignore" },
      );
      try { await fsp.unlink(confPath); } catch {}
      resolve(code ?? 0);
    });
  });
}

function buildShellQuotedCmd(argv: string[]): string {
  // Recreate a shell command from argv, quoting each component.
  // Example: bun /path/to/app.js --foo "bar baz"
  return argv.map(a => shq(a)).join(" ");
}

// Simple single-quote shell quoting
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
