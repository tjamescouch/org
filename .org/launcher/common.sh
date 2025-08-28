# shellcheck shell=bash
# Shared helpers for org launcher

DBG="${ORG_DEBUG:-${DEBUG:-0}}"
log() { [ "$DBG" = "1" ] && printf '[org.sh] %s\n' "$*" >&2 || true; }
err() { printf 'org: %s\n' "$*" >&2; }

# ---------------------------
# Parse CLI arguments
#   - sets:
#       ORG_UI, ORG_CWD
#       ORG_FWD_ARGS (array): everything else, in order
# ---------------------------
parse_args() {
  ORG_UI=""
  ORG_CWD=""

  # Portable array init (works on Bash 3.2). No Bash 4 '-g' flag.
  unset ORG_FWD_ARGS
  ORG_FWD_ARGS=()   # creates a global array in script scope

  while (($#)); do
    case "$1" in
      -C|--cwd)
        shift
        ORG_CWD="${1:-}"
        shift || true
        ;;
      --ui)
        shift
        ORG_UI="${1:-}"
        shift || true
        ;;
      --ui=*)
        ORG_UI="${1#*=}"
        shift
        ;;
      *)
        ORG_FWD_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

# ---------------------------
# Discover caller project root
#   - uses git toplevel if present; else $PWD
#   - sets ORG_PROJ and exports ORG_CALLER_CWD
# ---------------------------
detect_project_root() {
  if git -C "$PWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ORG_PROJ="$(git -C "$PWD" rev-parse --show-toplevel)"
  else
    ORG_PROJ="$PWD"
  fi
  export ORG_CALLER_CWD="$ORG_PROJ"
  log "project=$ORG_CALLER_CWD"
}

# ---------------------------
# Locate entrypoint
#   - IMPORTANT: always run the app from the repo where THIS launcher lives.
#   - sets ORG_ENTRY
# ---------------------------
find_entrypoint() {
  ORG_ENTRY="${ORG_ENTRY:-"$APPDIR/src/app.ts"}"
  if [ ! -f "$ORG_ENTRY" ]; then
    err "entrypoint not found: $ORG_ENTRY"
    return 66
  fi
  log "entry=$ORG_ENTRY"
}

# ---------------------------
# Container defaults
# ---------------------------
engine_defaults() {
  ORG_ENGINE="${ORG_ENGINE:-podman}"
  ORG_IMAGE="${ORG_IMAGE:-localhost/org-build:debian-12}"
  log "engine=$ORG_ENGINE image=$ORG_IMAGE"
}

# ---------------------------
# Prepare logs into <caller>/.org/logs
#   - sets ORG_LOG_DIR, ORG_LOG_FILE and last.log symlink
# ---------------------------
prepare_logs() {
  local base="${ORG_CALLER_CWD:-$PWD}"
  ORG_LOG_DIR="${ORG_LOG_DIR:-"$base/.org/logs"}"
  mkdir -p "$ORG_LOG_DIR" || true
  ORG_LOG_FILE="${ORG_LOG_FILE:-"$ORG_LOG_DIR/run-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"}"
  export ORG_LOG_DIR ORG_LOG_FILE
  ln -sf "$(basename "$ORG_LOG_FILE")" "$ORG_LOG_DIR/last.log" 2>/dev/null || true
  printf '[org.sh] preflight %s\n' "$(date -u +%FT%TZ)" | tee -a "$ORG_LOG_FILE" >/dev/null
  log "log_dir=$ORG_LOG_DIR"
  log "log_file=$ORG_LOG_FILE"
}
