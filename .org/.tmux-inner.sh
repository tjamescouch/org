set -Eeuo pipefail
umask 0002
: "${ORG_LOG_DIR:?}"
: "${ORG_LOG_FILE:?}"
: "${ENTRY:?}"

mkdir -p "$ORG_LOG_DIR"
echo "[tmux] log -> $ORG_LOG_FILE"
echo "[tmux] bun=$(command -v bun || echo MISSING) entry='$ENTRY' date=$(date -u +%FT%TZ)"

set +e
bun "$ENTRY" --ui console  2>&1 | tee -a "$ORG_LOG_FILE"
ec=${PIPESTATUS[0]}
set -e

echo "[tmux] app exited with $ec"
exit "$ec"
