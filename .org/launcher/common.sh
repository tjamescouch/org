# Sourced by ./org
# Minimal helpers shared by console.sh and tmux.sh

# -------------------
# Debug logging
# -------------------
DBG="${ORG_DEBUG:-${DEBUG:-0}}"
log() { [ "$DBG" = "1" ] && printf '[org.sh] %s\n' "$*" >&2 || true; }
err() { printf 'org: %s\n' "$*" >&2; }

# -------------------
# Args
#  - sets ORG_UI, ORG_CWD, ORG_FWD_ARGS (array)
# -------------------
parse_args() {
  ORG_UI=""
  ORG_CWD=""
  ORG_FWD_ARGS=()
  while (($#)); do
    case "$1" in
      -C|--cwd)  shift; ORG_CWD="${1:-}"; shift || true ;;
      --ui)      shift; ORG_UI="${1:-}"; shift || true ;;
      --ui=*)    ORG_UI="${1#*=}"; shift ;;
      *)         ORG_FWD_ARGS+=("$1"); shift ;;
    esac
  done
  export ORG_UI ORG_CWD
  # ORG_FWD_ARGS is left as a global array
  log "parsed: ui=${ORG_UI:-<default>} cwd=${ORG_CWD:-<none>} args=${#ORG_FWD_ARGS[@]}"
}

# -------------------
# Project root (repo you want to work on)
# -------------------
detect_project_root() {
  local seed="${PWD}"
  if [ -n "${ORG_CWD:-}" ]; then seed="$ORG_CWD"; fi

  if git -C "$seed" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ORG_PROJ="$(git -C "$seed" rev-parse --show-toplevel)"
  else
    ORG_PROJ="$seed"
  fi
  export ORG_PROJ
  export ORG_CALLER_CWD="$ORG_PROJ"
  log "project=$ORG_PROJ"
}

# -------------------
# Entrypoint resolution
# IMPORTANT: resolve relative to APPDIR (where the script lives),
# not ORG_PROJ (which may be a temp -C dir in tests).
# -------------------
find_entrypoint() {
  if [ -n "${ORG_ENTRY:-}" ] && [ -f "$ORG_ENTRY" ]; then
    log "entry (env)=$ORG_ENTRY"
    return 0
  fi

  local cands=(
    "$APPDIR/src/app.ts"
    "$APPDIR/app.ts"
    "$APPDIR/runner.ts"
    "$APPDIR/runner.mts"
    "$APPDIR/runner.js"
    "$APPDIR/dist/app.js"
    "$APPDIR/dist/runner.js"
  )
  local p
  for p in "${cands[@]}"; do
    if [ -f "$p" ]; then
      ORG_ENTRY="$p"
      export ORG_ENTRY
      log "entry=$ORG_ENTRY (exists)"
      return 0
    fi
  done

  err "entrypoint not found near $APPDIR (searched: ${cands[*]})"
  return 66
}

# -------------------
# Engine defaults
# -------------------
engine_defaults() {
  ORG_ENGINE="${ORG_ENGINE:-podman}"
  ORG_IMAGE="${ORG_IMAGE:-localhost/org-build:debian-12}"
  export ORG_ENGINE ORG_IMAGE
  log "engine=$ORG_ENGINE image=$ORG_IMAGE"
}

# -------------------
# Logs (always under <project>/.org/logs)
# -------------------
_prepare_log_dir() {
  local d="$1"
  mkdir -p "$d" || true
}

_ts_utc() { date -u +%Y-%m-%dT%H-%M-%SZ; }

prepare_logs() {
  ORG_LOG_DIR="${ORG_LOG_DIR:-"$ORG_PROJ/.org/logs"}"
  _prepare_log_dir "$ORG_LOG_DIR"
  ORG_LOG_FILE="${ORG_LOG_FILE:-"$ORG_LOG_DIR/run-$(_ts_utc).log"}"
  export ORG_LOG_DIR ORG_LOG_FILE
  ln -sf "$(basename "$ORG_LOG_FILE")" "$ORG_LOG_DIR/last.log" 2>/dev/null || true
  printf '[org.sh] preflight %s\n' "$(_ts_utc)" | tee -a "$ORG_LOG_FILE" >/dev/null
  log "log_dir=$ORG_LOG_DIR"
  log "log_file=$ORG_LOG_FILE"
}

# -------------------
# Arg join helper for tee-wrapping shell -lc calls
# -------------------
join_args_quoted() {
  local out=""
  local a
  for a in "${ORG_FWD_ARGS[@]:-}"; do
    out+=" $(printf '%q' "$a")"
  done
  printf '%s' "$out"
}
