#!/usr/bin/env bash
set -euo pipefail

file=src/orchestration/app.ts

echo "[INFO] wiring stdout think flattener + byte logger"

# Insert import (idempotent)
if ! grep -q "installStdoutThinkFlatten" "$file"; then
  sed -i '1i import { installStdoutThinkFlatten } from "../core/utils/stdout-think-flatten";' "$file"
fi

# Call the installer early (idempotent)
if ! grep -q "installStdoutThinkFlatten()" "$file"; then
  # after debug-hooks install (if present) or at top after imports
  awk '
    BEGIN{done=0}
    /installDebugHooks\(\)/ && done==0 {
      print;
      print "installStdoutThinkFlatten(); // SHOW_THINK=1 enables, DEBUG_COT=1 logs raw bytes";
      done=1;
      next
    }
    {print}
    END{
      if(done==0){
        print "installStdoutThinkFlatten(); // SHOW_THINK=1 enables, DEBUG_COT=1 logs raw bytes"
      }
    }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
fi

# Make sure source exists (created earlier)
test -f src/core/utils/stdout-think-flatten.ts || {
  echo "[ERR] src/core/utils/stdout-think-flatten.ts not found. Re-run the previous patch that added it."
  exit 1
}

git add -A
git commit -m "wire(stdout): installStdoutThinkFlatten at app bootstrap (enables DEBUG_COT logs)" || true
echo "[OK] done."
