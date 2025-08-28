# shellcheck shell=bash

run_console() {
  log "ui=console"
  export ORG_APPDIR="$APPDIR"
  export ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}"

  local BUN;  BUN="$(command -v bun  || true)"
  local NPX;  NPX="$(command -v npx  || true)"
  local NODE; NODE="$(command -v node || true)"

  if [ -n "$BUN" ]; then
    log "exec: $BUN \"$ORG_ENTRY\" ${ORG_FWD_ARGS[*]:-}"
    set +e
    "$BUN" "$ORG_ENTRY" "${ORG_FWD_ARGS[@]}" 2>&1 | tee -a "$ORG_LOG_FILE"
    local ec=${PIPESTATUS[0]}
    set -e
    exit "$ec"
  fi

  if [ -n "$NODE" ] && [ -n "$NPX" ]; then
    log "exec: $NPX --yes tsx \"$ORG_ENTRY\" ${ORG_FWD_ARGS[*]:-}"
    set +e
    "$NPX" --yes tsx "$ORG_ENTRY" "${ORG_FWD_ARGS[@]}" 2>&1 | tee -a "$ORG_LOG_FILE"
    local ec=${PIPESTATUS[0]}
    set -e
    exit "$ec"
  fi

  err "neither Bun nor Node+tsx found in PATH."
  exit 127
}
