#!/usr/bin/env bash
# scripts/tmux-launcher.sh
# Host-or-container bootstrap. On host, it runs the image; in-container, it writes
# /work/.org/tmux.conf and /work/.org/tmux-inner.sh and execs tmux.

set -Eeuo pipefail

if [[ ! -d /work ]]; then
  ENGINE="${SANDBOX_BACKEND:-podman}"
  IMAGE="${ORG_IMAGE:-localhost/org-build:debian-12}"
  PROJECT_DIR="${ORG_PROJECT_DIR:-$PWD}"

  if ! command -v "${ENGINE}" >/dev/null 2>&1; then
    echo "ERROR: ${ENGINE} not found on host. Set SANDBOX_BACKEND=podman and install Podman." >&2
    exit 1
  fi

  exec "${ENGINE}" run --rm -it \
    -v "${PROJECT_DIR}:/work" -w /work \
    "${IMAGE}" /usr/local/bin/org tmux
fi

# In-container pathing
ORG_DIR="/work/.org"
LOG_DIR="${ORG_DIR}/logs"
TMUX_CONF="${ORG_DIR}/tmux.conf"
INNER_SH="${ORG_DIR}/tmux-inner.sh"

BUN_BIN="${ORG_BUN_BIN:-/usr/local/bin/bun}"
TMUX_BIN="${ORG_TMUX_BIN:-/usr/bin/tmux}"

mkdir -p "${LOG_DIR}"
chmod 700 "${ORG_DIR}" || true

[[ -x "${BUN_BIN}" ]]  || { echo "ERROR: bun not found at ${BUN_BIN}"  >&2; exit 1; }
[[ -x "${TMUX_BIN}" ]] || { echo "ERROR: tmux not found at ${TMUX_BIN}" >&2; exit 1; }

# tmux.conf (sentinel comment for sanity checks)
cat > "${TMUX_CONF}" <<'TMUX_EOF'
# org-tmux-conf v1 — container-local runtime
set -g mouse on
set -g history-limit 100000
set -g default-terminal "screen-256color"
set -g escape-time 0
set -g detach-on-destroy off
setw -g remain-on-exit on
TMUX_EOF
chmod 600 "${TMUX_CONF}"

# inner runner
cat > "${INNER_SH}" <<'INNER_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
LOG_DIR="/work/.org/logs"
LOG_FILE="${LOG_DIR}/tmux-inner.log"
APP_ENTRY="/work/src/app.ts"
BUN_BIN="${ORG_BUN_BIN:-/usr/local/bin/bun}"

mkdir -p "${LOG_DIR}"

if [[ ! -f "${APP_ENTRY}" ]]; then
  echo "ERROR: entrypoint not found: ${APP_ENTRY}" | tee -a "${LOG_FILE}" >&2
  echo "Hint: run inside a repo mounted at /work with src/app.ts present." | tee -a "${LOG_FILE}" >&2
  echo "Press Ctrl+C to exit tmux pane." | tee -a "${LOG_FILE}" >&2
  tail -n +1 -f "${LOG_FILE}"
  exit 42
fi

{
  echo "===== org tmux-inner start: $(date -Is) ====="
  echo "cmd: ${BUN_BIN} ${APP_ENTRY} --ui console"
} | tee -a "${LOG_FILE}"

set +e
"${BUN_BIN}" "${APP_ENTRY}" --ui console 2>&1 | tee -a "${LOG_FILE}"
APP_CODE=${PIPESTATUS[0]}
set -e

echo "===== org tmux-inner exit code: ${APP_CODE} @ $(date -Is) =====" | tee -a "${LOG_FILE}"
echo "Pane will stay open; tailing log. Press Ctrl+C to exit." | tee -a "${LOG_FILE}"

exec tail -n +1 -f "${LOG_FILE}"
INNER_EOF
chmod 700 "${INNER_SH}"

exec "${TMUX_BIN}" -vv -f "${TMUX_CONF}" -L org new-session -A -s org "/work/.org/tmux-inner.sh"
