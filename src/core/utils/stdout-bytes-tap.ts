// Logs every byte written to stdout/stderr into logs/org-stdout-bytes-<ts>.log
import fs from "node:fs";
import path from "node:path";

let installed = false;

export function installStdoutBytesTap() {
  if (installed) return;
  installed = true;

  if (process.env.DEBUG_COT !== "1") return;

  const logsDir = path.join(process.cwd(), "logs");
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (e) { console.error(e) }

  const ts = Math.floor(Date.now()/1000);
  const file = path.join(logsDir, `org-stdout-bytes-${ts}.log`);
  const fd = fs.openSync(file, "a");

  const wOut = process.stdout.write.bind(process.stdout);
  const wErr = process.stderr.write.bind(process.stderr);

  // Write a small header (helps correlate runs)
  try {
    const envList = ["OAI_BASE","OAI_MODEL","LOG_LEVEL","SHOW_THINK","DEBUG_TRACE","SAFE_MODE"]
      .map(k => `${k}=${process.env[k] ?? ""}`).join("\n");
    fs.writeSync(fd, Buffer.from(`# --- env ---\n${envList}\n\n`));
  } catch (e) { console.error(e) }

  function teeWrite(orig: any) {
    return function(chunk: any, enc?: any, cb?: any) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc || "utf8");
      try { fs.writeSync(fd, buf); } catch (e) { console.error(e) }
      return orig(chunk, enc as any, cb as any);
    };
  }

  // Tap both stdout and stderr
  (process.stdout as any).write = teeWrite(wOut) as any;
  (process.stderr as any).write = teeWrite(wErr) as any;

  // Make path discoverable (optional)
  (global as any).__ORG_BYTES_LOG__ = file;

  // Friendly hint in normal logs
  try { wOut(`[DEBUG] bytes-tap -> ${file}\n`); } catch (e) { console.error(e) }

  process.on("exit", () => {
    try { fs.closeSync(fd); } catch (e) { console.error(e) }
  });
}
