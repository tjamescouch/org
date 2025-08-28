#!/usr/bin/env bash
set -Eeuo pipefail

# Smooth tmux launcher:
# - Auto-detect container engine (podman/docker)
# - Auto-build image from Containerfile/Dockerfile if not present
# - Start tmux inside the container in /work (bind-mount of repo)
# - Fall back to console UI if engine/image are unavailable

# --------------- small logging helpers ----------------
log() { printf '[org/tmux] %s\n' "$*" >&2; }
dbg() { [[ "${ORG_DEBUG_LAUNCHER:-0}" == "1" ]] && log "$*"; }

# --------------- repo paths ---------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPDIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"        # repo root on host
CTR_WORK="/work"                                   # bind mount target
CTR_APPDIR="${CTR_WORK}"                           # app root in container

# --------------- choose UI if forced ------------------
UI="${ORG_UI-}"
if [[ -z "${UI}" ]]; then
  for arg in "$@"; do
    case "$arg" in
      --ui=*) UI="${arg#--ui=}" ;;
      --ui)   shift; UI="${1-}"; break ;;
    esac
  done
fi
UI="${UI:-tmux}"

console_delegate() {
  dbg "delegating to console UI"
  ORG_UI=console ORG_FORCE_UI=console exec bash "${SCRIPT_DIR}/console.sh" "$@"
}

if [[ "${UI}" != "tmux" ]]; then
  console_delegate "$@"
fi

# --------------- detect container engine --------------
detect_engine() {
  if [[ -n "${ORG_ENGINE-}" ]]; then echo "${ORG_ENGINE}"; return 0; fi
  if command -v podman >/dev/null 2>&1; then echo podman; return 0; fi
  if command -v docker >/dev/null 2>&1; then echo docker; return 0; fi
  return 1
}
ENGINE="$(detect_engine || true)"

if [[ -z "${ENGINE}" ]]; then
  log "No container engine (podman/docker) found; falling back to console UI."
  console_delegate "$@"
fi
dbg "ENGINE=${ENGINE}"

# --------------- resolve / build image ----------------
IMAGE="${ORG_IMAGE:-${SANDBOX_IMAGE:-${ORG_SANDBOX_IMAGE:-}}}"
DEFAULT_TAG="org-dev:latest"

engine_image_exists() {
  local tag="$1"
  if [[ "${ENGINE}" == "podman" ]]; then
    podman image exists "${tag}"
  else
    docker image inspect "${tag}" >/dev/null 2>&1
  fi
}

engine_build() {
  local tag="$1" file="$2"
  log "Preparing dev image (first run only)…"
  if [[ "${ENGINE}" == "podman" ]]; then
    # -q prints image ID only (quiet)
    podman build -q -t "${tag}" -f "${file}" "${APPDIR}" >/dev/null
  else
    DOCKER_BUILDKIT=1 docker build -q -t "${tag}" -f "${file}" "${APPDIR}" >/dev/null
  fi
}

ensure_image() {
  if [[ -n "${IMAGE}" ]]; then
    dbg "Using provided image: ${IMAGE}"
    echo "${IMAGE}"
    return 0
  fi

  # If a local dev image already exists, use it; otherwise build it.
  if engine_image_exists "${DEFAULT_TAG}"; then
    dbg "Found local image: ${DEFAULT_TAG}"
    echo "${DEFAULT_TAG}"
    return 0
  fi

  local f=
  if [[ -f "${APPDIR}/Containerfile" ]]; then f="${APPDIR}/Containerfile"
  elif [[ -f "${APPDIR}/Dockerfile" ]]; then f="${APPDIR}/Dockerfile"
  fi

  if [[ -n "${f}" ]]; then
    engine_build "${DEFAULT_TAG}" "${f}" || {
      log "Image build failed; falling back to console UI."
      console_delegate "$@"
    }
    echo "${DEFAULT_TAG}"
    return 0
  fi

  log "No Containerfile/Dockerfile found; falling back to console UI."
  console_delegate "$@"
}

IMAGE="$(ensure_image "$@")"
dbg "IMAGE=${IMAGE}"

# --------------- logs --------------------------------
ORG_LOG_DIR="${ORG_LOG_DIR:-${APPDIR}/.org/logs}"
mkdir -p "${ORG_LOG_DIR}" "${ORG_LOG_DIR}/tmux-logs" || true
LOG_FILE_HOST="${ORG_LOG_DIR}/tmux-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

# --------------- forward args to app -----------------
declare -a ORG_ARGS=("$@")
if [[ -n "${ORG_FWD_ARGS-}" ]]; then
  read -r -a _fwd <<<"${ORG_FWD_ARGS}"
  ORG_ARGS+=("${_fwd[@]}")
fi
printf -v ARGS_JOINED ' %q' "${ORG_ARGS[@]}"

# --------------- mount (SELinux-friendly) ------------
MNT_SPEC="${APPDIR}:${CTR_WORK}"
case "${ENGINE}" in
  podman|docker) MNT_SPEC="${MNT_SPEC}:z" ;;
esac

# --------------- inner app runner (inside tmux) ------
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

# Ensure we run in the bind-mounted repo (/work)
cd "$ORG_APPDIR"

set +e
bun "$ENTRY" --ui console __ORG_ARGS_PLACEHOLDER__ 2>&1 | tee -a "$ORG_LOG_FILE"
ec=${PIPESTATUS[0]}
set -e

echo "[tmux] app exited with $ec"
exit "$ec"
EOS
CREATE_AND_RUN="${CREATE_AND_RUN/__ORG_ARGS_PLACEHOLDER__/${ARGS_JOINED}}"

# --------------- tmux wrapper (inside container) ----
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

# --------------- run container ----------------------
# Always invoke console.sh via bash if we ever need to delegate again.
if [[ "${ENGINE}" == "podman" ]]; then
  exec podman run --rm -it --network host \
    -v "${MNT_SPEC}" \
    -w "${CTR_WORK}" \
    -e ORG_TMUX=1 \
    -e ORG_FORCE_UI=console \
    -e ORG_APPDIR="${CTR_APPDIR}" \
    -e ORG_CALLER_CWD="${CTR_WORK}" \
    -e ORG_LOG_DIR="${CTR_APPDIR}/.org/logs" \
    -e ORG_LOG_FILE="${CTR_APPDIR}/.org/logs/$(basename "${LOG_FILE_HOST}")" \
    -e ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}" \
    "${IMAGE}" bash -lc "${WRAPPER}"
else
  exec docker run --rm -it --network host \
    -v "${MNT_SPEC}" \
    -w "${CTR_WORK}" \
    -e ORG_TMUX=1 \
    -e ORG_FORCE_UI=console \
    -e ORG_APPDIR="${CTR_APPDIR}" \
    -e ORG_CALLER_CWD="${CTR_WORK}" \
    -e ORG_LOG_DIR="${CTR_APPDIR}/.org/logs" \
    -e ORG_LOG_FILE="${CTR_APPDIR}/.org/logs/$(basename "${LOG_FILE_HOST}")" \
    -e ORG_LOG_LEVEL="${ORG_LOG_LEVEL:-${LOG_LEVEL:-info}}" \
    "${IMAGE}" bash -lc "${WRAPPER}"
fi
