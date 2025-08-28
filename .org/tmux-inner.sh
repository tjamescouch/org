#!/usr/bin/env bash
set -Eeuo pipefail
: "${TERM:=xterm-256color}"
: "${LANG:=en_US.UTF-8}"

if [[ -z "${ORG_TMUX_ENTRY:-}" ]]; then
  echo "[tmux-inner] ORG_TMUX_ENTRY is empty" >&2
  exit 64
fi

# Run in a login shell so PATH and rc files behave
exec bash -lc "$ORG_TMUX_ENTRY"
