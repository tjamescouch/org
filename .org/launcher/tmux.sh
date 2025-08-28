# Sourced by ./org
# Run the app inside tmux, in a container. We keep logs under <project>/.org/logs.

run_tmux_in_container() {
  log "ui=tmux entry=$ORG_ENTRY proj=$ORG_PROJ appdir=$APPDIR"

  local CTR_WORK="/work"          # mount point for the PROJECT
  local CTR_APPDIR="$CTR_WORK"    # appdir for logging defaults inside container is project root
  local CTR_ENTRY                 # code entrypoint must be bind-mounted too
  local HOST_MOUNT="$ORG_PROJ:$CTR_WORK:Z"

  # We also need to mount the REPO where the entry lives (APPDIR) if it differs from ORG_PROJ.
  # Bind it under /code and compute the inside path to ORG_ENTRY.
  local codeMount=""
  local codeInside="/code"
  if [ "$APPDIR" != "$ORG_PROJ" ]; then
    codeMount="-v $APPDIR:$codeInside:Z"
    CTR_ENTRY="$codeInside/${ORG_ENTRY#$APPDIR/}"
  else
    CTR_ENTRY="$CTR_WORK/${ORG_ENTRY#$ORG_PROJ/}"
  fi

  mkdir -p "$ORG_PROJ/.org/logs" "$ORG_PROJ/.org/logs/tmux-logs" || true
  local LOG_FILE_HOST="$ORG_PROJ/.org/logs/tmux-$(_ts_utc).log"

  log "mount proj: $HOST_MOUNT"
  [ -n "$codeMount" ] && log "mount code: $codeMount"
  log "host tmux log: $LOG_FILE_HOST"
  log "ctr entry: $CTR_ENTRY"

  # Join args safely
  local JOINED; JOINED="$(join_args_quoted)"

  local INNER_SCRIPT="$CTR_APPDIR/.org/.tmux-inner.sh"
  local CREATE_AND_RUN
  CREATE_AND_RUN=$(
    cat <<'EOS'
set -Eeuo pipefail
umask 0002
EOS
  )
  CREATE_AND_RUN+="
ORG_LOG_DIR=\"$CTR_APPDIR/.org/logs\"
ORG_LOG_FILE=\"$CTR_APPDIR/.org/logs/$(basename "$LOG_FILE_HOST")\"
ENTRY=\"$CTR_ENTRY\"
export ORG_LOG_DIR ORG_LOG_FILE ENTRY
mkdir -p \"\$ORG_LOG_DIR\" \"$CTR_APPDIR/.org/logs/tmux-logs\"
cat > \"$INNER_SCRIPT\" <<'INN'
set -Eeuo pipefail
umask 0002
: \"\${ORG_LOG_DIR:?}\"
: \"\${ORG_LOG_FILE:?}\"
: \"\${ENTRY:?}\"
echo \"[tmux] log -> \$ORG_LOG_FILE\"
echo \"[tmux] bun=\$(command -v bun || echo 'MISSING') entry='\$ENTRY' date=\$(date -u +%FT%TZ)\"
set +e
bun \"\$ENTRY\" --ui console $JOINED 2>&1 | tee -a \"\$ORG_LOG_FILE\"
ec=\${PIPESTATUS[0]}
set -e
echo \"[tmux] app exited with \$ec\"
exit \"\$ec\"
INN
chmod +x \"$INNER_SCRIPT\"
export TMUX_TMPDIR=\"$CTR_APPDIR/.org/logs/tmux-logs\"
tmux -vv new -A -s org bash --noprofile --norc \"$INNER_SCRIPT\"
"

  # shellcheck disable=SC2086
  exec "$ORG_ENGINE" run --rm -it --network host \
    -v "$HOST_MOUNT" $codeMount \
    -w "$CTR_WORK" \
    -e ORG_TMUX=1 \
    -e ORG_FORCE_UI=console \
    -e ORG_APPDIR="$CTR_APPDIR" \
    -e ORG_CALLER_CWD="$CTR_WORK" \
    -e ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}" \
    "$ORG_IMAGE" bash -lc "$CREATE_AND_RUN"
}
