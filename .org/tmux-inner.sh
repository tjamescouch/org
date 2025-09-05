#!/usr/bin/env bash

mkdir -p /work/.org/logs
touch /work/.org/logs

set -Eeuo pipefail
{
  echo "[tmux-inner] $(date -Is) starting"
  echo "[tmux-inner] PATH=$PATH"
  command -v bun || echo "[tmux-inner] bun not in PATH"
} >> /work/.org/logs/tmux-inner.log 2>&1


umask 0002

export TERM=xterm-256color
export LANG=en_US.UTF-8

BUN="/usr/local/bin/bun"
if ! command -v "$BUN" >/dev/null 2>&1; then
  if command -v bun >/dev/null 2>&1; then
    BUN="$(command -v bun)"
  elif [ -x /home/ollama/.bun/bin/bun ]; then
    BUN="/home/ollama/.bun/bin/bun"
  elif [ -x /root/.bun/bin/bun ]; then
    BUN="/root/.bun/bin/bun"
  fi
fi

if [ -z "${BUN:-}" ] || [ ! -x "$BUN" ]; then
  echo "[tmux-inner] bun not found" >&2
  exit 127
fi

cd /work
exec "$BUN" /work/src/app.ts --ui console
