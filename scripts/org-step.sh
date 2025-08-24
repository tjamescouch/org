#!/usr/bin/env bash
# scripts/org-step.sh
# Runs a single command inside the sandbox session and records stdout/stderr/metadata.
# Requires: bash, coreutils, timeout, date, kill, setsid

set -euo pipefail

CMD="${1:-}"
if [[ -z "$CMD" ]]; then
  echo "usage: org-step.sh '<command>'" >&2
  exit 2
fi

# Config via env
IDX="${ORG_STEP_IDX:-0}"
OUT_DIR="${ORG_OUT_DIR:-/work/.org/steps}"
TIMEOUT_MS="${ORG_TIMEOUT_MS:-30000}"
STDOUT_MAX="${ORG_STDOUT_MAX:-1048576}" # 1 MiB
LIMIT_PIDS="${ORG_PIDS_MAX:-128}"
# Note: memory/cpu mostly enforced by container cgroups

mkdir -p "$OUT_DIR"

OUT_FILE="$OUT_DIR/step-$IDX.out"
ERR_FILE="$OUT_DIR/step-$IDX.err"
META_FILE="$OUT_DIR/step-$IDX.meta.json"

# Per-call hygiene
ulimit -u "${LIMIT_PIDS}" || true
ulimit -n 1024 || true

start_ts="$(date -Is)"
# Run in its own process group so we can cleanly kill children.
# We capture raw stdout/stderr into files; truncate after.
set +e
timeout_s=$(( (TIMEOUT_MS + 999) / 1000 ))
# shellcheck disable=SC3045
setsid bash -lc "$CMD" >"$OUT_FILE" 2>"$ERR_FILE" &
pid="$!"
wait "$pid"
ec="$?"
set -e
end_ts="$(date -Is)"

killedBy=""
if [[ $ec -eq 124 || $ec -eq 137 ]]; then
  killedBy="timeout"
fi

# Truncate large outputs
if [[ -f "$OUT_FILE" ]]; then
  size=$(stat -c%s "$OUT_FILE" 2>/dev/null || stat -f%z "$OUT_FILE")
  if (( size > STDOUT_MAX )); then
    # truncate/cut without loading to RAM
    dd if="$OUT_FILE" of="${OUT_FILE}.tmp" bs="${STDOUT_MAX}" count=1 status=none || true
    mv "${OUT_FILE}.tmp" "$OUT_FILE"
  fi
fi
if [[ -f "$ERR_FILE" ]]; then
  size=$(stat -c%s "$ERR_FILE" 2>/dev/null || stat -f%z "$ERR_FILE")
  if (( size > STDOUT_MAX )); then
    dd if="$ERR_FILE" of="${ERR_FILE}.tmp" bs="${STDOUT_MAX}" count=1 status=none || true
    mv "${ERR_FILE}.tmp" "$ERR_FILE"
  fi
fi

# Kill any stragglers from the step (its process group)
# pgrep -g requires procps; fall back to kill -- -pid
pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
if [[ -n "$pgid" ]]; then
  kill -TERM "-$pgid" 2>/dev/null || true
  sleep 0.1
  kill -KILL "-$pgid" 2>/dev/null || true
fi

# Clean /tmp for next step
rm -rf /tmp/* 2>/dev/null || true

cat >"$META_FILE" <<JSON
{
  "idx": ${IDX},
  "cmd": $(printf '%s' "$CMD" | jq -Rs '.'),
  "startedAt": $(printf '%s' "$start_ts" | jq -Rs '.'),
  "endedAt": $(printf '%s' "$end_ts" | jq -Rs '.'),
  "exitCode": $ec,
  "killedBy": $( [[ -n "$killedBy" ]] && printf '%s' "$killedBy" | jq -Rs '.' || echo null ),
  "stdoutPath": $(printf '%s' "$OUT_FILE" | jq -Rs '.'),
  "stderrPath": $(printf '%s' "$ERR_FILE" | jq -Rs '.')
}
JSON

exit "$ec"
