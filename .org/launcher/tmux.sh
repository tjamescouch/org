#!/usr/bin/env bash
set -Eeuo pipefail

# Run org inside a containerized tmux session with a predictable CWD (/work).
# Changes vs your restored script:
#   - Inner script does: cd "$ORG_APPDIR" (== /work) BEFORE launching bun.
#   - tmux new-session tries: -c /work (start-directory). Falls back if unsupported.

# ---- resolve paths ----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPDIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"                # repo root on host
CTR_WORK="/work"
CTR_APPDIR="${CTR_WORK}"

# ---- container engine & image ----------------------------------------------
ENGINE="${ORG_ENGINE:-}"
if [[ -z "${ENGINE}" ]]; then
  if command -v podman >/dev/null 2>&1; then ENGINE="podman"
  elif command -v docker >/dev/null 2>&1; then ENGINE="docker"
  else
    echo "No container engine found (podman or docker)." >&2
    exit 1
  fi
fi

IMAGE="${ORG_IMAGE:-${SANDBOX_IMAGE:-${ORG_SANDBOX_IMAGE:-}}}"
if [[ -z "${IMAGE}" ]]; then
  echo "Set ORG_IMAGE (or SANDBOX_IMAGE/ORG_SANDBOX_IMAGE) to the dev image that has tmux+bun." >&2
  exit 1
fi

# ---- logs -------------------------------------------------------------------
ORG_LOG_DIR="${ORG_LOG_DIR:-${APPDIR}/.org/logs}"
mkdir -p "${ORG_LOG_DIR}" "${ORG_LOG_DIR}/tmux-logs" || true
LOG_FILE_HOST="${ORG_LOG_DIR}/tmux-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

# ---- forward args -----------------------------------------------------------
# Combine argv and optional ORG_FWD_ARGS string into a single args array
declare -a ORG_ARGS=("$@")
if [[ -n "${ORG_FWD_ARGS-}" ]]; then
  # shellwords-ish split; upstream should quote if needed
  read -r -a _fwd <<<"${ORG_FWD_ARGS}"
  ORG_ARGS+=("${_fwd[@]}")
fi
printf -v ARGS_JOINED ' %q' "${ORG_ARGS[@]}"

# ---- mount options ----------------------------------------------------------
MNT_SPEC="${APPDIR}:${CTR_WORK}"
# Add :z/:Z label where supported (SELinux contexts)
case "${ENGINE}" in
  podman|docker) MNT_SPEC="${MNT_SPEC}:z" ;;
esac

# ---- inner script that tmux actually runs -----------------------------------
# Key fix: `cd "$ORG_APPDIR"` ensures the app CWD is /work before bun starts.
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

# >>> FIX: guarantee predictable working directory inside tmux <<<
cd "$ORG_APPDIR"

set +e
bun "$ENTRY" --ui console __ORG_ARGS_PLACEHOLDER__ 2>&1 | tee -a "$ORG_LOG_FILE"
ec=${PIPESTATUS[0]}
set -e

echo "[tmux] app exited with $ec"
exit "$ec"
EOS
# inject the joined args into the heredoc safely
CREATE_AND_RUN="${CREATE_AND_RUN/__ORG_ARGS_PLACEHOLDER__/${ARGS_JOINED}}"

# ---- wrapper that creates the inner script and starts tmux ------------------
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

# Try to set the session start-directory to /work (-c). If not supported, fall back.
if tmux new-session -d -s org -c "$CTR_WORK" "bash --noprofile --norc '$INNER_TMUX_SCRIPT'"; then
  :
else
  tmux new-session -d -s org "bash --noprofile --norc '$INNER_TMUX_SCRIPT'"
fi

exec tmux attach -t org
EOS
# substitute placeholders
WRAPPER="${WRAPPER/__CTR_APPDIR__/${CTR_APPDIR}}"
WRAPPER="${WRAPPER/__CTR_WORK__/${CTR_WORK}}"
# careful to inject the whole inner script text
# (printf %q would over-escape; we embed via heredoc above)
WRAPPER="${WRAPPER/__CREATE_AND_RUN__/${CREATE_AND_RUN}}"

# ---- run the container ------------------------------------------------------
exec "${ENGINE}" run --rm -it --network host \
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
