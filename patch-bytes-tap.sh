#!/usr/bin/env bash
set -euo pipefail

echo "[INFO] add stdout bytes tap (DEBUG_COT=1) and wire at app bootstrap"

APP="src/orchestration/app.ts"
UTIL="src/core/utils/stdout-bytes-tap.ts"

if [[ ! -f "$APP" ]]; then
  echo "[ERR ] cannot find $APP (run from repo root)"; exit 1
fi

mkdir -p "$(dirname "$UTIL")" logs

# 1) Create the tap utility (idempotent overwrite)
cat > "$UTIL" <<'TS'
// Logs every byte written to stdout/stderr into logs/org-stdout-bytes-<ts>.log
import fs from "node:fs";
import path from "node:path";

let installed = false;

export function installStdoutBytesTap() {
  if (installed) return;
  installed = true;

  if (process.env.DEBUG_COT !== "1") return;

  const logsDir = path.join(process.cwd(), "logs");
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}

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
  } catch {}

  function teeWrite(orig: any) {
    return function(chunk: any, enc?: any, cb?: any) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc || "utf8");
      try { fs.writeSync(fd, buf); } catch {}
      return orig(chunk, enc as any, cb as any);
    };
  }

  // Tap both stdout and stderr
  (process.stdout as any).write = teeWrite(wOut) as any;
  (process.stderr as any).write = teeWrite(wErr) as any;

  // Make path discoverable (optional)
  (global as any).__ORG_BYTES_LOG__ = file;

  // Friendly hint in normal logs
  try { wOut(`[DEBUG] bytes-tap -> ${file}\n`); } catch {}

  process.on("exit", () => {
    try { fs.closeSync(fd); } catch {}
  });
}
TS

# 2) Ensure import is present (idempotent)
if ! grep -q 'installStdoutBytesTap' "$APP"; then
  tmp="$(mktemp)"
  {
    echo 'import { installStdoutBytesTap } from "../core/utils/stdout-bytes-tap";'
    cat "$APP"
  } > "$tmp" && mv "$tmp" "$APP"
  echo "[INFO] import inserted in $APP"
fi

# 3) Ensure call is present right after imports (idempotent)
if ! grep -q 'installStdoutBytesTap()' "$APP"; then
  tmp="$(mktemp)"
  awk '
    BEGIN{did=0}
    {
      if(did==0 && $0 !~ /^[[:space:]]*import[[:space:]]/) {
        print "if (process.env.DEBUG_COT === \"1\") { try { installStdoutBytesTap(); } catch (e) { console.error(\"bytes tap failed:\", e); } }";
        did=1;
      }
      print $0
    }
    END{
      if(did==0){
        print "if (process.env.DEBUG_COT === \"1\") { try { installStdoutBytesTap(); } catch (e) { console.error(\"bytes tap failed:\", e); } }";
      }
    }
  ' "$APP" > "$tmp" && mv "$tmp" "$APP"
  echo "[INFO] call inserted in $APP"
fi

git add -A
git commit -m "wire(bytes-tap): DEBUG_COT=1 logs raw stdout/stderr bytes to logs/"
echo "[OK ] patch complete."
echo
echo "Next:"
echo "  DEBUG_COT=1 ./run.sh"
echo "Then tail the newest file in logs/:"
echo "  ls -tr logs/org-stdout-bytes-*.log | tail -1 | xargs -I{} bash -lc 'echo === {}; echo; sed -n 1,120p {}'"
