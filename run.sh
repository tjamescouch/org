# run.sh
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
chmod +x ./apply_patch || true
export PATH="$PWD:$PWD/scripts:$PATH"
exec ./src/app.ts "$@"

