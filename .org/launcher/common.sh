# Common helpers for the org launcher (bash only)

# ---------- logging ----------
DBG="${ORG_DEBUG:-${DEBUG:-0}}"
log() { [ "$DBG" = "1" ] && printf '[org.sh] %s\n' "$*" >&2 || true; }
err() { printf 'org: %s\n' "$*" >&2; }

# ---------- args ----------
# Sets: ORG_UI, ORG_CWD, ORG_FWD_ARGS (array)
parse_args() {
  ORG_UI=""
  ORG_CWD=""
  ORG_FWD_ARGS=()
  while (($#)); do
    case "$1" in
      -C|--cwd) shift; ORG_CWD="${1:-}"; shift || true ;;
      --ui)     shift; ORG_UI="${1:-}"; shift || true ;;
      --ui=*)   ORG_UI="${1#*=}"; shift ;;
      *)        ORG_FWD_ARGS+=("$1"); shift ;;
    esac
  done
  log "parsed args: ui=${ORG_UI:-<default>} cwd=${ORG_CWD:-<none>} fwd=${ORG_FWD_ARGS[*]:-<none>}"
}

# Join args for safe re-injection into a single command line.
# Prints a leading space when there is at least one arg.
join_args() {
  local out="" a
  for a in "$@"; do
    out+=" $(printf '%q' "$a")"
  done
  printf '%s' "$out"
}

# ---------- project / entry ----------
detect_project_root() {
  if git -C "$PWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ORG_PROJ="$(git -C "$PWD" rev-parse --show-toplevel)"
  else
    ORG_PROJ="$PWD"
  fi
  export ORG_CALLER_CWD="$ORG_PROJ"
  log "project=$ORG_CALLER_CWD"
}

find_entrypoint() {
  ORG_ENTRY="${ORG_ENTRY:-"$ORG_PROJ/src/app.ts"}"
  if [ ! -f "$ORG_ENTRY" ]; then
    err "entrypoint not found: $ORG_ENTRY"
    return 66
  fi
  if [ "$DBG" = "1" ]; then
    ls -l "$ORG_ENTRY" >&2 || true
    head -n 1 "$ORG_ENTRY" >&2 || true
  fi
  log "entry=$ORG_ENTRY"
  return 0
}

# ---------- container defaults ----------
engine_defaults() {
  ORG_ENGINE="${ORG_ENGINE:-podman}"
  ORG_IMAGE="${ORG_IMAGE:-localhost/org-build:debian-12}"
  log "engine=$ORG_ENGINE image=$ORG_IMAGE"
}

# ---------- logging to disk ----------
prepare_logs() {
  ORG_LOG_DIR="${ORG_LOG_DIR:-"$ORG_PROJ/.org/logs"}"
  mkdir -p "$ORG_LOG_DIR" || true
  ORG_LOG_FILE="${ORG_LOG_FILE:-"$ORG_LOG_DIR/run-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"}"
  export ORG_LOG_DIR ORG_LOG_FILE
  ln -sf "$(basename "$ORG_LOG_FILE")" "$ORG_LOG_DIR/last.log" 2>/dev/null || true
  printf '[org.sh] preflight %s\n' "$(date -u +%FT%TZ)" | tee -a "$ORG_LOG_FILE" >/dev/null
  log "log_dir=$ORG_LOG_DIR"
  log "log_file=$ORG_LOG_FILE"
  export ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}"
}
