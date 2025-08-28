# Tmux in container runner

run_tmux_in_container() {
  log "ui=tmux"

  local CTR_WORK="/work"       # container project root (repo root)
  local CTR_APPDIR="$CTR_WORK" # app dir is the repo root
  local CTR_ENTRY="$CTR_APPDIR/src/app.ts"
  local MNT="$ORG_PROJ:$CTR_WORK:Z"

  mkdir -p "$ORG_PROJ/.org/logs" "$ORG_PROJ/.org/logs/tmux-logs" || true
  local LOG_FILE_HOST="$ORG_PROJ/.org/logs/tmux-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

  log "mount: $MNT"
  log "host tmux log: $LOG_FILE_HOST"

  # arguments to pass to the inner script (as "$@")
  local ARGS_JOINED=""
  if [ "${#ORG_FWD_ARGS[@]:-0}" -gt 0 ]; then
    local a
    for a in "${ORG_FWD_ARGS[@]}"; do
      ARGS_JOINED+=" $(printf '%q' "$a")"
    done
  fi

  local INNER_SCRIPT="$CTR_APPDIR/.org/.tmux-inner.sh"

  # Create inner script INSIDE the container
  local CREATE_AND_RUN="
set -Eeuo pipefail
umask 0002

echo '[ctr] creating log dirs and inner script...'
mkdir -p \"$CTR_APPDIR/.org/logs\" \"$CTR_APPDIR/.org/logs/tmux-logs\"

cat > \"$INNER_SCRIPT\" <<'EOS'
set -Eeuo pipefail
umask 0002

: \"\${ORG_LOG_DIR:?ORG_LOG_DIR not set}\"
: \"\${ORG_LOG_FILE:?ORG_LOG_FILE not set}\"
: \"\${ENTRY:?ENTRY not set}\"

mkdir -p \"\$ORG_LOG_DIR\"
echo \"[tmux] log -> \$ORG_LOG_FILE\"
echo \"[tmux] bun=\$(command -v bun || echo 'MISSING') entry='\$ENTRY' date=\$(date -u +%FT%TZ)\"

set +e
bun \"\$ENTRY\" --ui console \"\$@\" 2>&1 | tee -a \"\$ORG_LOG_FILE\"
ec=\${PIPESTATUS[0]}
set -e

echo \"[tmux] app exited with \$ec\"
exit \"\$ec\"
EOS

chmod +x \"$INNER_SCRIPT\"

export ENTRY=\"$CTR_ENTRY\"
export TMUX_TMPDIR=\"$CTR_APPDIR/.org/logs/tmux-logs\"

echo '[ctr] starting tmux -vv ...'
tmux -vv new -A -s org bash --noprofile --norc \"$INNER_SCRIPT\" $ARGS_JOINED
"

  log "about to exec container (this should replace the current process)"
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
