# Console UI runner (host)

run_console() {
  log "ui=console"
  export ORG_APPDIR="$ORG_PROJ"
  export ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}"

  local joined; joined="$(join_args "${ORG_FWD_ARGS[@]:-}")"

  if command -v bun >/dev/null 2>&1; then
    log "exec: bun \"$ORG_ENTRY\" ${ORG_FWD_ARGS[*]-}"
    # use bash -lc so PATH/profile env are normal; tee to capture early failures
    exec bash -lc 'bun '"$(printf '%q' "$ORG_ENTRY")${joined}"' 2>&1' | tee -a "$ORG_LOG_FILE"
  fi

  if command -v node >/dev/null 2>&1; then
    if command -v npx >/dev/null 2>&1; then
      log "exec: npx --yes tsx \"$ORG_ENTRY\" ${ORG_FWD_ARGS[*]-}"
      exec bash -lc 'npx --yes tsx '"$(printf '%q' "$ORG_ENTRY")${joined}"' 2>&1' | tee -a "$ORG_LOG_FILE"
    fi
    err "Node found but tsx is missing. Install tsx (npm i -g tsx) or install Bun."
    return 127
  fi

  err "neither Bun nor Node runtime found in PATH."
  return 127
}
