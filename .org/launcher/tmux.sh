#!/usr/bin/env bash
set -euo pipefail

# run inside a container and open a tmux session that runs the console UI
run_tmux_in_container() {
  log "ui=tmux"

  local PROJ="${ORG_PROJ}"
  local CTR_WORK="/work"               # mount repo root here
  local CTR_ENTRY="$CTR_WORK/src/app.ts"
  local MNT="$PROJ:$CTR_WORK:Z"

  mkdir -p "$PROJ/.org/logs" "$PROJ/.org/logs/tmux-logs" || true
  local LOG_FILE_HOST="$PROJ/.org/logs/tmux-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

  # join forwarded args safely
  local ARGS_JOINED=""
  if [ "${#ORG_FWD_ARGS[@]:-0}" -gt 0 ]; then
    for a in "${ORG_FWD_ARGS[@]}"; do ARGS_JOINED+=" $(printf '%q' "$a")"; done
  fi

  # inner script path (inside the container)
  local INNER_SCRIPT="$CTR_WORK/.org/.tmux-inner.sh"

  # create the inner script and launch tmux (all inside the container)
  local CREATE_AND_RUN="
set -Eeuo pipefail
umask 0002

echo '[ctr] creating log dirs and inner script...'
mkdir -p '$CTR_WORK/.org/logs' '$CTR_WORK/.org/logs/tmux-logs'

cat > '$INNER_SCRIPT' <<'EOS'
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

chmod +x '$INNER_SCRIPT'

export ENTRY='$CTR_ENTRY'
export TMUX_TMPDIR='$CTR_WORK/.org/logs/tmux-logs'

echo '[ctr] starting tmux -vv ...'
tmux -vv new -A -s org bash --noprofile --norc '$INNER_SCRIPT' $ARGS_JOINED
"

  log "about to exec container"

  exec "$ORG_ENGINE" run --rm -it --network host \
    -v "$MNT" \
    -w "$CTR_WORK" \
    -e ORG_TMUX=1 \
    -e ORG_FORCE_UI=console \
    -e ORG_APPDIR="$CTR_WORK" \
    -e ORG_CALLER_CWD="$CTR_WORK" \
    -e ORG_LOG_DIR="$CTR_WORK/.org/logs" \
    -e ORG_LOG_FILE="$CTR_WORK/.org/logs/$(basename "$LOG_FILE_HOST")" \
    -e ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}" \
    -e SANDBOX_BACKEND=none \            # <<< the important bit
    "$ORG_IMAGE" bash -lc "$CREATE_AND_RUN"
}
