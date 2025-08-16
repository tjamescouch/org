/**
 * Safe Mode gate for shell commands.
 * When SAFE_MODE=1 or "--safe" is present, we prompt on /dev/tty before
 * child_process.spawn/exec/execFile.
 */
import * as fs from "node:fs";

// lazy require to avoid type friction
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cp = require("node:child_process");

type Decision = "run" | "skip" | "quit";

function confirmSync(tag: string, command: string, args: string[] = []): Decision {
  const line = args.length ? [command, ...args].join(" ") : command;
  const prompt =
    `\n[SAFE] ${tag} about to run:\n$ ${line}\n` +
    `[Enter]=run  [s]=skip  [q]=quit > `;

  try { fs.writeSync(process.stderr.fd, prompt); } catch (e) { console.error(e) }

  let input = "";
  const readOneLine = (fd: number) => {
    const buf = Buffer.alloc(1024);
    try {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      return String(buf.slice(0, Math.max(0, n))).trim().toLowerCase();
    } catch { return ""; }
  };

  // Prefer reading from the TTY so we don't clash with piped stdin
  try {
    const fd = fs.openSync("/dev/tty", "rs");
    input = readOneLine(fd);
    fs.closeSync(fd);
  } catch {
    // Fallback to stdin if /dev/tty not available
    try { input = readOneLine(0); } catch (e) { console.error(e) }
  }

  if (input === "q") return "quit";
  if (input === "s") return "skip";
  return "run";
}

export function installSafeMode() {
  // idempotent
  if ((globalThis as any).__safeModeInstalled) return;
  (globalThis as any).__safeModeInstalled = true;

  const enabled = process.env.SAFE_MODE === "1" || process.argv.includes("--safe");
  if (!enabled) return;

  const orig = {
    spawn: cp.spawn,
    exec: cp.exec,
    execFile: cp.execFile,
  };

  try { process.stderr.write("[SAFE] Safe Mode enabled: confirm before shell commands.\n"); } catch (e) { console.error(e) }

  cp.spawn = function(command: string, args?: any, options?: any) {
    const argv: string[] = Array.isArray(args) ? args : [];
    const decision = confirmSync("spawn", command, argv);
    if (decision === "quit") { process.stderr.write("[SAFE] quit.\n"); process.exit(130); }
    if (decision === "skip") { process.stderr.write("[SAFE] skipped.\n");
      // return a short-lived dummy process
      return orig.spawn("bash", ["-lc", "true"], { stdio: "ignore" });
    }
    return orig.spawn.apply(this, arguments as unknown as any[]);
  };

  cp.exec = function(command: string, options?: any, cb?: any) {
    const decision = confirmSync("exec", command);
    if (decision === "quit") { process.stderr.write("[SAFE] quit.\n"); process.exit(130); }
    if (decision === "skip") {
      process.stderr.write("[SAFE] skipped.\n");
      const maybeCb = typeof options === "function" ? options : cb;
      if (typeof maybeCb === "function") { maybeCb(null, { stdout: "", stderr: "" }); return null; }
      return null;
    }
    return orig.exec.apply(this, arguments as unknown as any[]);
  };

  cp.execFile = function(file: string, args?: any, options?: any, cb?: any) {
    const argv: string[] = Array.isArray(args) ? args : [];
    const decision = confirmSync("execFile", file, argv);
    if (decision === "quit") { process.stderr.write("[SAFE] quit.\n"); process.exit(130); }
    if (decision === "skip") {
      process.stderr.write("[SAFE] skipped.\n");
      const maybeCb = typeof options === "function" ? options : cb;
      if (typeof maybeCb === "function") { maybeCb(null, { stdout: "", stderr: "" }); return null; }
      // return dummy proc for API symmetry
      return orig.spawn("bash", ["-lc", "true"], { stdio: "ignore" });
    }
    return orig.execFile.apply(this, arguments as unknown as any[]);
  };
}
