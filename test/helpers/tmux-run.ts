// test/helpers/tmux-run.ts
import { spawnSync, spawn } from "child_process";
import * as path from "path";
import * as os from "os";
import { promises as fsp } from "fs";

function shq(s: string) { return `'${s.replace(/'/g, `'\\''`)}'`; }

type Send = { delay?: number; keys: string };
type RunResult = { code: number; out: string; err: string };

export async function runOrgInTmux(opts: {
  bin: string;         // path to 'org' binary/entry (or "org" if on PATH)
  cwd: string;
  args?: string[];     // CLI args; include ["--ui","tmux"]
  sends?: Send[];      // keys to send (tmux send-keys syntax; e.g., "C-c", "Escape", "i", "hello", "Enter")
  attachTimeoutMs?: number;
  sessionName?: string;
}): Promise<RunResult> {
  const sock = `test-${process.pid}-${Date.now()}`;
  const session = opts.sessionName || "test";
  const attachTimeoutMs = opts.attachTimeoutMs ?? 8000;

  const confDir = await fsp.mkdtemp(path.join(os.tmpdir(), "org-test-tmux-"));
  const confPath = path.join(confDir, "tmux.conf");
  // Very small config for tests
  await fsp.writeFile(confPath, [
    "set -g history-limit 50000",
    "set -g status off",
    "set -g mouse off",
    'set -ag terminal-overrides ",*:Tc"',
  ].join("\n"), "utf8");

  const argv = [opts.bin, ...(opts.args || [])];
  const cmd = argv.map(shq).join(" ");

  // Start detached session running the app
  let r = spawnSync("bash", ["-lc",
    `tmux -L ${shq(sock)} -f ${shq(confPath)} new-session -d -s ${shq(session)} "bash -lc ${shq(cmd)}"`
  ], { cwd: opts.cwd, encoding: "utf8" });
  if (r.status !== 0) {
    return { code: r.status ?? 1, out: r.stdout || "", err: r.stderr || "" };
  }

  // Give app a moment to start
  await delay(250);

  // Drive keys
  for (const s of (opts.sends || [])) {
    if (s.delay) await delay(s.delay);
    const keys = s.keys.split(/\s+/).filter(Boolean).map(shq).join(" ");
    spawnSync("bash", ["-lc", `tmux -L ${shq(sock)} send-keys -t ${shq(session)}:1 ${keys}`], {
      cwd: opts.cwd, stdio: "ignore"
    });
  }

  // Wait a bit for output to settle
  await delay(attachTimeoutMs);

  // Capture the pane
  const cap = spawnSync("bash", ["-lc",
    `tmux -L ${shq(sock)} capture-pane -t ${shq(session)}:1 -epJ \\; show-buffer`
  ], { cwd: opts.cwd, encoding: "utf8" });

  // Try to kill session (don’t error if already exited)
  spawnSync("bash", ["-lc", `tmux -L ${shq(sock)} kill-session -t ${shq(session)} >/dev/null 2>&1 || true`]);

  return { code: cap.status ?? 0, out: cap.stdout || "", err: cap.stderr || "" };
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }
