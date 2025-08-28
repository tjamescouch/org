#!/usr/bin/env bash
# org/launcher/tmux-inner.sh
# (Static copy; tmux.sh writes an updated version at runtime.)
set -Eeuo pipefail
umask 0002

export PATH="/home/ollama/.bun/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export TERM="${TERM:-xterm-256color}"
export LANG="${LANG:-en_US.UTF-8}"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1,host.containers.internal,192.168.56.1}"

if [ -z "${ORG_OPENAI_BASE:-}" ]; then
  if [ -n "${OPENAI_BASE_URL:-}" ]; then
    ORG_OPENAI_BASE="${OPENAI_BASE_URL%/}"
  elif [ -n "${LMSTUDIO_URL:-}" ]; then
    ORG_OPENAI_BASE="${LMSTUDIO_URL%/}/v1"
  elif [ -n "${ORG_OPENAI_BASE_DEFAULT:-}" ]; then
    ORG_OPENAI_BASE="${ORG_OPENAI_BASE_DEFAULT%/}"
  else
    ORG_OPENAI_BASE="http://host.containers.internal:11434/v1"
  fi
  export ORG_OPENAI_BASE
fi

echo "[tmux] ORG_OPENAI_BASE=$ORG_OPENAI_BASE  NO_PROXY=$NO_PROXY  PATH=$PATH" >&2

: "${ENTRY:=bun /work/src/app.ts --ui console}"
exec bash -lc "$ENTRY"
