#!/usr/bin/env bash
# scripts/tmux-launcher.sh
# Runs the container with the repo's wrapper overlay-mounted.
# Env forwarding: ORG_*, OPENAI_*, OLLAMA_*, ANTHROPIC_*, AZURE_*, HF_* and proxies.

set -Eeuo pipefail

ENGINE="${ORG_CONTAINER_ENGINE:-}"
if [[ -z "${ENGINE}" ]]; then
  if command -v podman >/dev/null 2>&1; then ENGINE=podman
  elif command -v docker >/dev/null 2>&1; then ENGINE=docker
  else echo "ERROR: neither podman nor docker found; set ORG_CONTAINER_ENGINE."; exit 1; fi
fi

IMAGE="${ORG_IMAGE:-localhost/org-build:debian-12}"
MODE="${1:-tmux}" # default tmux; or pass 'console'

case "${MODE}" in tmux|console) ;; *) echo "Usage: $0 [tmux|console]"; exit 2 ;; esac

SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$PWD"

args=( run --rm -it
  -v "${TARGET_DIR}:/work"
  -v "${SELF_ROOT}/scripts/org:/usr/local/bin/org:ro"
  -v "${SELF_ROOT}/scripts/org-launch-tmux:/usr/local/libexec/org/launch-tmux:ro"
  -v "${SELF_ROOT}/scripts/org-launch-console:/usr/local/libexec/org/launch-console:ro"
  -w /work
  -e ORG_EXTERNAL_TMUX_BOOTSTRAP=1
)

# auto-forward env
forward_prefix(){ local p="$1"; while IFS='=' read -r k _; do [[ "$k" == $p* ]] && args+=(-e "$k"); done < <(env); }
forward_exact(){ for n in "$@"; do env | grep -q "^${n}=" && args+=(-e "$n"); done; }

forward_prefix ORG_
forward_prefix OPENAI_
forward_prefix OLLAMA_
forward_prefix ANTHROPIC_
forward_prefix AZURE_
forward_prefix HF_
forward_exact HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy

args+=( "${IMAGE}" org --ui "${MODE}" )
exec "${ENGINE}" "${args[@]}"
