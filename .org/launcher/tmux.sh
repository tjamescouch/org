# shellcheck shell=bash

_join_args() {
  local s=""
  local a
  for a in "${ORG_FWD_ARGS[@]}"; do
    s+=" $(printf '%q' "$a")"
  done
  printf '%s' "$s"
}

run_tmux_in_container() {
  log "ui=tmux"

  local SRC="$APPDIR"
  local CTR_WORK="/work"
  local CTR_APPDIR="$CTR_WORK"
  local CTR_ENTRY="$CTR_APPDIR/src/app.ts"
  local MNT="$SRC:$CTR_WORK:Z"

  mkdir -p "$ORG_LOG_DIR" "$ORG_LOG_DIR/tmux-logs" || true
  local LOG_FILE_HOST="$ORG_LOG_DIR/tmux-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

  log "mount: $MNT"
  log "host tmux log: $LOG_FILE_HOST"

  local ARGS_JOINED; ARGS_JOINED="$(_join_args)"

  local CREATE_AND_RUN="
set -Eeuo pipefail
umask 0002

mkdir -p \"$CTR_APPDIR/.org/logs\" \"$CTR_APPDIR/.org/logs/tmux-logs\"

cat > \"$CTR_APPDIR/.org/.tmux-inner.sh\" <<'EOS'
set -Eeuo pipefail
umask 0002
: \"\${ORG_LOG_DIR:?}\"
: \"\${ORG_LOG_FILE:?}\"
: \"\${ENTRY:?}\"

mkdir -p \"\$ORG_LOG_DIR\"
echo \"[tmux] log -> \$ORG_LOG_FILE\"
echo \"[tmux] bun=\$(command -v bun || echo MISSING) entry='\$ENTRY' date=\$(date -u +%FT%TZ)\"

set +e
bun \"\$ENTRY\" --ui console $ARGS_JOINED 2>&1 | tee -a \"\$ORG_LOG_FILE\"
ec=\${PIPESTATUS[0]}
set -e

echo \"[tmux] app exited with \$ec\"
exit \"\$ec\"
EOS

chmod +x \"$CTR_APPDIR/.org/.tmux-inner.sh\"

export ENTRY=\"$CTR_ENTRY\"
export TMUX_TMPDIR=\"$CTR_APPDIR/.org/logs/tmux-logs\"
tmux -vv new -A -s org bash --noprofile --norc \"$CTR_APPDIR/.org/.tmux-inner.sh\"
"

  log "about to exec container"
  exec "$ORG_ENGINE" run --rm -it --network host \
    -v "$MNT" \
    -w "$CTR_WORK" \
    -e ORG_TMUX=1 \
    -e ORG_FORCE_UI=console \
    -e ORG_APPDIR="$CTR_APPDIR" \
    -e ORG_CALLER_CWD="$CTR_WORK" \
    -e ORG_LOG_DIR="$CTR_APPDIR/.org/logs" \
    -e ORG_LOG_FILE="$CTR_APPDIR/.org/logs/$(basename "$LOG_FILE_HOST")" \
    -e ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}" \
    "$ORG_IMAGE" bash -lc "$CREATE_AND_RUN"
}
