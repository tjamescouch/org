#!/usr/bin/env bash
# container/entrypoint.sh
# - Mirrors /project -> /work (idempotent).
# - Baselines /work as a git repo for patch diffs.
# - If /run/llm.sock exists, exposes it at 127.0.0.1:11434 via uds-bridge.py.
# - Exports sane defaults for LLM_BASE_URL / OPENAI_BASE_URL.
set -euo pipefail

: "${PROJECT_MOUNT:=/project}"
: "${WORKDIR:=/work}"
: "${ORG_DEFAULT_CWD:=/work}"
: "${APP_CMD:=org}"

log(){ printf '[entrypoint] %s\n' "$*" >&2; }

mkdir -p "${WORKDIR}" "${WORKDIR}/.org"

log "Mirror /project -> /work"
if command -v rsync >/dev/null 2>&1; then
  # rsync wrapper injects --omit-dir-times
  rsync -a --delete \
    --exclude ".git/***" \
    --exclude ".org/***" \
    --filter="P .org/" \
    "${PROJECT_MOUNT}/." "${WORKDIR}/"
else
  find "${WORKDIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "${PROJECT_MOUNT}/." "${WORKDIR}/"
fi

cd "${WORKDIR}"
if ! [ -d .git ]; then
  git init -q
  git config user.email "org@example.com"
  git config user.name  "org"
  git add -A || true
  git commit -qm "baseline" || true
fi

# Default CWD for the application
if [ -n "${ORG_DEFAULT_CWD:-}" ] && [ -d "${ORG_DEFAULT_CWD}" ]; then
  cd "${ORG_DEFAULT_CWD}"
fi

# If the VM mounted a UNIX socket, expose it as 127.0.0.1:11434 inside the container.
if [ -S "${ORG_LLM_SOCKET:-/run/llm.sock}" ]; then
  if ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "127\.0\.0\.1:11434$"; then
    nohup python3 -u /usr/local/bin/uds-bridge.py \
      --tcp 127.0.0.1:11434 --unix "${ORG_LLM_SOCKET:-/run/llm.sock}" \
      >/dev/null 2>&1 &
    log "uds-bridge: 127.0.0.1:11434 -> ${ORG_LLM_SOCKET:-/run/llm.sock}"
  fi
fi

# Ensure the app defaults to the in-container bridge.
export LLM_BASE_URL="${LLM_BASE_URL:-http://host.containers.internal:11434/v1}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$LLM_BASE_URL}"

log "exec: ${APP_CMD} $*"
exec ${APP_CMD} "$@"
