#!/usr/bin/env bash
# scripts/org-step.sh
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

# Always operate in the writable workspace
cd /work || { echo "cannot cd to /work" >&2; exit 97; }
mkdir -p "$OUT_DIR"

OUT_FILE="$OUT_DIR/step-$IDX.out"
ERR_FILE="$OUT_DIR/step-$IDX.err"
META_FILE="$OUT_DIR/step-$IDX.meta.json"

ulimit -u "${LIMIT_PIDS}" || true
ulimit -n 1024 || true

start_ts="$(date -Is)"

# Run the command; capture stdout/stderr; create the files even if empty
set +e
echo ORG_TRY=1 setsid bash -lc "$CMD" >"$OUT_FILE" 2>"$ERR_FILE" &
ORG_TRY=1 setsid bash -lc "$CMD" >"$OUT_FILE" 2>"$ERR_FILE" &
pid="$!"
wait "$pid"
ec="$?"
set -e
end_ts="$(date -Is)"

killedBy=""
if [[ $ec -eq 124 || $ec -eq 137 ]]; then
  killedBy="timeout"
fi

# Truncate overly large outputs (best-effort)
if [[ -f "$OUT_FILE" ]]; then
  size=$(stat -c%s "$OUT_FILE" 2>/dev/null || stat -f%z "$OUT_FILE")
  if (( size > STDOUT_MAX )); then
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

# Kill stray children
pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
if [[ -n "${pgid:-}" ]]; then
  kill -TERM "-$pgid" 2>/dev/null || true
  sleep 0.1
  kill -KILL "-$pgid" 2>/dev/null || true
fi

rm -rf /tmp/* 2>/dev/null || true

# Write a tiny meta (jq optional; fall back to raw JSON)
if command -v jq >/dev/null 2>&1; then
  cmd_json=$(printf '%s' "$CMD" | jq -Rs '.')
  s_json=$(printf '%s' "$start_ts" | jq -Rs '.')
  e_json=$(printf '%s' "$end_ts" | jq -Rs '.')
else
  # crude escape; enough for debugging
  esc() { printf '"%s"' "$(printf '%s' "$1" | sed 's/"/\\"/g')"; }
  cmd_json=$(esc "$CMD"); s_json=$(esc "$start_ts"); e_json=$(esc "$end_ts");
fi

cat >"$META_FILE" <<JSON
{
  "idx": ${IDX},
  "cmd": ${cmd_json},
  "startedAt": ${s_json},
  "endedAt": ${e_json},
  "exitCode": ${ec},
  "killedBy": $( [[ -n "$killedBy" ]] && printf '%s' "$killedBy" | sed 's/.*/"&"/' || echo null ),
  "stdoutPath": "$(printf '%s' "$OUT_FILE")",
  "stderrPath": "$(printf '%s' "$ERR_FILE")"
}
JSON

exit "$ec"
