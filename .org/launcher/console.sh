# Sourced by ./org
# Console runner that tees stdout/stderr into the log for early runtime failures.

run_console() {
  log "ui=console entry=$ORG_ENTRY proj=$ORG_PROJ appdir=$APPDIR"

  export ORG_APPDIR="$ORG_PROJ"
  export ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}"

  local JOINED; JOINED="$(join_args_quoted)"

  if command -v bun >/dev/null 2>&1; then
    log "exec: bun \"$ORG_ENTRY\"$JOINED"
    exec bash -lc 'bun "'"$ORG_ENTRY"'" '"$JOINED 2>&1"' | tee -a "'"$ORG_LOG_FILE"'"'
  fi

  if command -v node >/dev/null 2>&1; then
    if command -v npx >/dev/null 2>&1; then
      log "exec: npx --yes tsx \"$ORG_ENTRY\"$JOINED"
      exec bash -lc 'npx --yes tsx "'"$ORG_ENTRY"'" '"$JOINED 2>&1"' | tee -a "'"$ORG_LOG_FILE"'"'
    fi
    err "Node found but tsx is missing. Install tsx (npm i -g tsx) or install Bun."
    exit 127
  fi

  err "neither Bun nor Node runtime found in PATH."
  exit 127
}
