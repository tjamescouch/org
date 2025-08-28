#!/usr/bin/env bash
# vim: set ts=2 sw=2 et:
set -Eeuo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# tmux UI launcher with targeted logging
# - High-signal, single-file log: .org/logs/launcher-<UTC>.log
# - Stage markers + reasons for any fallback to console
# - Error/exit traps (print failing line and command)
# - No behavior changes beyond logging
# ──────────────────────────────────────────────────────────────────────────────

# ===== logging plumbing =======================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPDIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ORG_LOG_DIR="${ORG_LOG_DIR:-${APPDIR}/.org/logs}"
mkdir -p "${ORG_LOG_DIR}" || true
LAUNCH_LOG="${ORG_LOG_DIR}/launcher-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

# tee both stdout+stderr to the log (and to your terminal)
exec > >(awk '{ print; fflush() }' | tee -a "${LAUNCH_LOG}") 2>&1

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '[%s] [org/tmux] %s\n' "$(ts)" "$*"; }
dbg() { [[ "${ORG_DEBUG_LAUNCHER:-0}" == "1" ]] && log "DEBUG: $*"; }
stage() { log "── $*"; }

on_err() {
  local ec=$? line=${BASH_LINENO[0]-?} cmd=${BASH_COMMAND:-?}
  log "ERROR at line ${line}: ${cmd} (exit ${ec})"
}
on_exit() {
  local ec=$?
  log "launcher exit code: ${ec}"
}
trap on_err ERR
trap on_exit EXIT

stage "launcher start"
log "log file -> ${LAUNCH_LOG}"
log "pwd: $(pwd)"
log "APPDIR: ${APPDIR}"
log "SCRIPT_DIR: ${SCRIPT_DIR}"

# ===== helpers ================================================================
console_delegate() {
  local why="${1:-unspecified}"
  stage "fallback to console UI (reason: ${why})"
  # Force console in child to avoid bouncing back here.
  ORG_UI=console ORG_FORCE_UI=console exec bash "${SCRIPT_DIR}/console.sh" "${@:2}"
}

detect_engine() {
  if [[ -n "${ORG_ENGINE-}" ]]; then echo "${ORG_ENGINE}"; return 0; fi
  if command -v podman >/dev/null 2>&1; then echo podman; return 0; fi
  if command -v docker >/dev/null 2>&1; then echo docker; return 0; fi
  return 1
}

# ===== UI selection ===========================================================
UI="${ORG_UI-}"
if [[ -z "${UI}" ]]; then
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
log "UI selected: ${UI}"

if [[ "${UI}" != "tmux" ]]; then
  console_delegate "UI is '${UI}' (not tmux)" "$@"
fi

# ===== engine detection =======================================================
ENGINE="$(detect_engine || true)"
if [[ -z "${ENGINE}" ]]; then
  console_delegate "no container engine (podman/docker) found" "$@"
fi
log "ENGINE: ${ENGINE}"

# ===== image resolution =======================================================
IMAGE="${ORG_IMAGE:-${SANDBOX_IMAGE:-${ORG_SANDBOX_IMAGE:-}}}"
if [[ -z "${IMAGE}" ]]; then
  # For now, just log the reason and use console. (We can auto-build next.)
  console_delegate "no ORG_IMAGE/SANDBOX_IMAGE provided" "$@"
fi
log "IMAGE: ${IMAGE}"

# ===== args & mount ===========================================================
CTR_WORK="/work"
CTR_APPDIR="${CTR_WORK}"

declare -a ORG_ARGS=("$@")
if [[ -n "${ORG_FWD_ARGS-}" ]]; then
  # naive split is fine—upstream should pass quoted values if needed
  read -r -a _fwd <<<"${ORG_FWD_ARGS}"
  ORG_ARGS+=("${_fwd[@]}")
fi
printf -v ARGS_JOINED ' %q' "${ORG_ARGS[@]}"
dbg "ARGS_JOINED: ${ARGS_JOINED}"

MNT_SPEC="${APPDIR}:${CTR_WORK}"
case "${ENGINE}" in
  podman|docker) MNT_SPEC="${MNT_SPEC}:z" ;;
esac
log "mount: ${MNT_SPEC}"

# ===== log plumbing for tmux path ============================================
mkdir -p "${ORG_LOG_DIR}/tmux-logs" || true
TMUX_LOG_HOST="${ORG_LOG_DIR}/tmux-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"
log "tmux host log -> ${TMUX_LOG_HOST}"

# ===== inside-container runner ===============================================
read -r -d '' CREATE_AND_RUN <<'EOS'
set -Eeuo pipefail
umask 0002

: "${ORG_LOG_DIR:?}"
: "${ORG_LOG_FILE:?}"
: "${ENTRY:?}"
: "${ORG_APPDIR:?}"

echo "[tmux] cwd(before cd): $(pwd)"
mkdir -p "$ORG_LOG_DIR"
echo "[tmux] log -> $ORG_LOG_FILE"
echo "[tmux] entry='$ENTRY' date=$(date -u +%FT%TZ)"

# ensure we're in the bind-mounted repo
cd "$ORG_APPDIR"
echo "[tmux] cwd(after cd): $(pwd)"
echo "[tmux] ls -1 (head):"
ls -1 | head -20

set +e
bun "$ENTRY" --ui console __ORG_ARGS_PLACEHOLDER__ 2>&1 | tee -a "$ORG_LOG_FILE"
ec=${PIPESTATUS[0]}
set -e

echo "[tmux] app exited with $ec"
exit "$ec"
EOS
CREATE_AND_RUN="${CREATE_AND_RUN/__ORG_ARGS_PLACEHOLDER__/${ARGS_JOINED}}"

# ===== tmux wrapper (created inside container) ===============================
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

echo "[wrapper] tmux version: $(tmux -V || true)"
echo "[wrapper] ENTRY=$ENTRY"
echo "[wrapper] ORG_APPDIR=$ORG_APPDIR"
echo "[wrapper] TMUX_TMPDIR=$TMUX_TMPDIR"

# Try to start session in /work; fall back if -c unsupported.
if tmux new-session -d -s org -c "$CTR_WORK" "bash --noprofile --norc '$INNER_TMUX_SCRIPT'"; then
  :
else
  echo "[wrapper] tmux -c unsupported; starting without -c"
  tmux new-session -d -s org "bash --noprofile --norc '$INNER_TMUX_SCRIPT'"
fi

exec tmux attach -t org
EOS
WRAPPER="${WRAPPER/__CTR_APPDIR__/${CTR_APPDIR}}"
WRAPPER="${WRAPPER/__CTR_WORK__/${CTR_WORK}}"
WRAPPER="${WRAPPER/__CREATE_AND_RUN__/${CREATE_AND_RUN}}"

# ===== run container (with diagnostics) ======================================
cmd_common=(
  -v "${MNT_SPEC}"
  -w "${CTR_WORK}"
  -e ORG_TMUX=1
  -e ORG_FORCE_UI=console
  -e ORG_APPDIR="${CTR_APPDIR}"
  -e ORG_CALLER_CWD="${CTR_WORK}"
  -e ORG_LOG_DIR="${CTR_APPDIR}/.org/logs"
  -e ORG_LOG_FILE="${CTR_APPDIR}/.org/logs/$(basename "${TMUX_LOG_HOST}")"
  -e ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}"
)

stage "running container (tmux path)"
log "engine: ${ENGINE}"
log "image:  ${IMAGE}"
dbg "container WRAPPER (first 200 chars): $(printf '%s' "${WRAPPER}" | head -c 200)"

set +e
if [[ "${ENGINE}" == "podman" ]]; then
  podman run --rm -it --network host "${cmd_common[@]}" "${IMAGE}" bash -lc "${WRAPPER}"
else
  docker run --rm -it --network host "${cmd_common[@]}" "${IMAGE}" bash -lc "${WRAPPER}"
fi
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  log "tmux container returned rc=${rc}; falling back to console"
  console_delegate "container rc=${rc}" "${ORG_ARGS[@]}"
fi

stage "launcher done"
