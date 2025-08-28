#!/usr/bin/env bash
set -Eeuo pipefail

# Smooth tmux launcher:
# - Prefer containerized tmux (podman/docker) if available
# - Always ensure CWD=/work inside the container (bind-mounted repo)
# - If anything in the tmux path isn’t available, fall back to console UI
# - Never require env like ORG_IMAGE for basic use

log() { printf '[org/tmux] %s\n' "$*" >&2; }
dbg() { [[ "${ORG_DEBUG_LAUNCHER:-0}" == "1" ]] && log "$*"; }

# --- repo paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPDIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"            # host repo root
CTR_WORK="/work"
CTR_APPDIR="${CTR_WORK}"

# --- UI selection (CLI or env) ---
UI="${ORG_UI-}"
if [[ -z "${UI}" ]]; then
  # parse --ui console|tmux or --ui=console|tmux
  for ((i=1; i<=$#; i++)); do
    a="${!i}"
    if [[ "$a" == "--ui" ]]; then
      j=$((i+1)); UI="${!j:-}"; break
    elif [[ "$a" == --ui=* ]]; then
      UI="${a#--ui=}"; break
    fi
  done
fi
UI="${UI:-tmux}"

console_delegate() {
  dbg "delegating to console UI"
  # Force console in the child so we don’t bounce back here.
  ORG_UI=console ORG_FORCE_UI=console exec bash "${SCRIPT_DIR}/console.sh" "$@"
}

if [[ "${UI}" != "tmux" ]]; then
  console_delegate "$@"
fi

# --- detect container engine ---
detect_engine() {
  if [[ -n "${ORG_ENGINE-}" ]]; then echo "${ORG_ENGINE}"; return 0; fi
  if command -v podman >/dev/null 2>&1; then echo podman; return 0; fi
  if command -v docker >/dev/null 2>&1; then echo docker; return 0; fi
  return 1
}
ENGINE="$(detect_engine || true)"
if [[ -z "${ENGINE}" ]]; then
  dbg "no container engine; using console"
  console_delegate "$@"
fi
dbg "ENGINE=${ENGINE}"

# --- image resolution (optional) ---
# If user supplied ORG_IMAGE / SANDBOX_IMAGE, we use it; otherwise we gently
# fall back to console UI (no errors for non-technical users).
IMAGE="${ORG_IMAGE:-${SANDBOX_IMAGE:-${ORG_SANDBOX_IMAGE:-}}}"
if [[ -z "${IMAGE}" ]]; then
  dbg "no image provided; using console"
  console_delegate "$@"
fi
dbg "IMAGE=${IMAGE}"

# --- logs ---
ORG_LOG_DIR="${ORG_LOG_DIR:-${APPDIR}/.org/logs}"
mkdir -p "${ORG_LOG_DIR}" "${ORG_LOG_DIR}/tmux-logs" || true
LOG_FILE_HOST="${ORG_LOG_DIR}/tmux-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

# --- forward args (CLI + ORG_FWD_ARGS string) ---
declare -a ORG_ARGS=("$@")
if [[ -n "${ORG_FWD_ARGS-}" ]]; then
  read -r -a _fwd <<<"${ORG_FWD_ARGS}"
  ORG_ARGS+=("${_fwd[@]}")
fi
printf -v ARGS_JOINED ' %q' "${ORG_ARGS[@]}"

# --- mount (SELinux-friendly) ---
MNT_SPEC="${APPDIR}:${CTR_WORK}"
case "${ENGINE}" in
  podman|docker) MNT_SPEC="${MNT_SPEC}:z" ;;
esac

# --- inner app runner (executed *inside* tmux) ---
read -r -d '' CREATE_AND_RUN <<'EOS'
set -Eeuo pipefail
umask 0002

: "${ORG_LOG_DIR:?}"
: "${ORG_LOG_FILE:?}"
: "${ENTRY:?}"
: "${ORG_APPDIR:?}"

mkdir -p "$ORG_LOG_DIR"
echo "[tmux] log -> $ORG_LOG_FILE"
echo "[tmux] entry='$ENTRY' date=$(date -u +%FT%TZ)"

# Guarantee predictable working directory
cd "$ORG_APPDIR"

set +e
bun "$ENTRY" --ui console __ORG_ARGS_PLACEHOLDER__ 2>&1 | tee -a "$ORG_LOG_FILE"
ec=${PIPESTATUS[0]}
set -e

echo "[tmux] app exited with $ec"
exit "$ec"
EOS
CREATE_AND_RUN="${CREATE_AND_RUN/__ORG_ARGS_PLACEHOLDER__/${ARGS_JOINED}}"

# --- tmux wrapper (created inside the container) ---
read -r -d '' WRAPPER <<'EOS'
set -Eeuo pipefail
umask 0002

CTR_APPDIR="__CTR_APPDIR__"
CTR_WORK="__CTR_WORK__"
INNER_TMUX_SCRIPT="$CTR_APPDIR/.org/.tmux-inner.sh"

mkdir -p "$CTR_APPDIR/.org/logs" "$CTR_APPDIR/.org/logs/tmux-logs"

cat > "$INNER_TMUX_SCRIPT" <<'INNERSH'
__CREATE_AND_RUN__
INNERSH
chmod +x "$INNER_TMUX_SCRIPT"

export ENTRY="$CTR_APPDIR/src/app.ts"
export ORG_APPDIR="$CTR_APPDIR"
export TMUX_TMPDIR="$CTR_APPDIR/.org/logs/tmux-logs"

# Prefer starting the session in /work; fall back if -c unsupported.
if tmux new-session -d -s org -c "$CTR_WORK" "bash --noprofile --norc '$INNER_TMUX_SCRIPT'"; then
  :
else
  tmux new-session -d -s org "bash --noprofile --norc '$INNER_TMUX_SCRIPT'"
fi

exec tmux attach -t org
EOS
WRAPPER="${WRAPPER/__CTR_APPDIR__/${CTR_APPDIR}}"
WRAPPER="${WRAPPER/__CTR_WORK__/${CTR_WORK}}"
WRAPPER="${WRAPPER/__CREATE_AND_RUN__/${CREATE_AND_RUN}}"

# --- run the container ---
run_container() {
  if [[ "${ENGINE}" == "podman" ]]; then
    podman run --rm -it --network host \
      -v "${MNT_SPEC}" -w "${CTR_WORK}" \
      -e ORG_TMUX=1 -e ORG_FORCE_UI=console \
      -e ORG_APPDIR="${CTR_APPDIR}" -e ORG_CALLER_CWD="${CTR_WORK}" \
      -e ORG_LOG_DIR="${CTR_APPDIR}/.org/logs" \
      -e ORG_LOG_FILE="${CTR_APPDIR}/.org/logs/$(basename "${LOG_FILE_HOST}")" \
      -e ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}" \
      "${IMAGE}" bash -lc "${WRAPPER}"
  else
    docker run --rm -it --network host \
      -v "${MNT_SPEC}" -w "${CTR_WORK}" \
      -e ORG_TMUX=1 -e ORG_FORCE_UI=console \
      -e ORG_APPDIR="${CTR_APPDIR}" -e ORG_CALLER_CWD="${CTR_WORK}" \
      -e ORG_LOG_DIR="${CTR_APPDIR}/.org/logs" \
      -e ORG_LOG_FILE="${CTR_APPDIR}/.org/logs/$(basename "${LOG_FILE_HOST}")" \
      -e ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}" \
      "${IMAGE}" bash -lc "${WRAPPER}"
  fi
}

# If the container run fails for any reason, fall back to console UI.
# (Non-technical users must never be left with a broken launch.)
if ! run_container; then
  log "tmux container failed; falling back to console UI."
  console_delegate "${ORG_ARGS[@]}"
fi
