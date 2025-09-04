#!/usr/bin/env bash
# scripts/tmux-launcher.sh
# Host helper. Mounts the target repo at /work and passes env to disable nested sandbox
# and the internal tmux bootstrap.
#
# Examples:
#   ./scripts/tmux-launcher.sh                      # use $PWD → /work, UI=tmux
#   ./scripts/tmux-launcher.sh --ui console         # UI=console
#   ./scripts/tmux-launcher.sh --repo owner/repo    # clone into .org/workspaces and use it
#   ./scripts/tmux-launcher.sh --repo https://github.com/oven-sh/bun.git --branch main
#
# Env:
#   SANDBOX_BACKEND=podman|docker|none (default: none)
#   ORG_SANDBOX_BACKEND                (default: none)
#   ORG_IMAGE=localhost/org-build:debian-12
#   SANDBOX_BACKEND selects the host engine ONLY for this launcher (still default none)

set -Eeuo pipefail

ENGINE="${SANDBOX_BACKEND:-podman}"
IMAGE="${ORG_IMAGE:-localhost/org-build:debian-12}"
MODE="tmux"
REPO_SPEC=""
BRANCH=""
HOST_ROOT="${ORG_PROJECT_DIR:-$PWD}"

# ---- parse args ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ui)       shift; MODE="${1:-tmux}"; shift || true ;;
    --ui=*)     MODE="${1#--ui=}"; shift ;;
    --repo)     shift; REPO_SPEC="${1:-}"; shift || true ;;
    --repo=*)   REPO_SPEC="${1#--repo=}"; shift ;;
    --branch)   shift; BRANCH="${1:-}"; shift || true ;;
    --branch=*) BRANCH="${1#--branch=}"; shift ;;
    -h|--help|help)
      cat >&2 <<'H'
Usage: scripts/tmux-launcher.sh [--ui tmux|console] [--repo <url|owner/repo>] [--branch <name>]
H
      exit 0 ;;
    *) echo "WARN: ignoring arg: $1" >&2; shift ;;
  esac
done

slugify() {
  printf "%s" "$1" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's#^https?://##; s#\.git$##; s#[^a-z0-9]+#-#g; s#^-+##; s#-+$##'
}

ensure_repo_dir() {
  local target="$1" url="$2"
  mkdir -p "$(dirname "$target")"
  if [[ ! -d "$target/.git" ]]; then
    local branch_opt=()
    [[ -n "${BRANCH}" ]] && branch_opt=(--branch "${BRANCH}")
    git clone --depth 1 "${branch_opt[@]}" "$url" "$target"
  fi
}

TARGET_DIR="${HOST_ROOT}"
if [[ -n "${REPO_SPEC}" ]]; then
  if [[ "${REPO_SPEC}" =~ ^(https?://|git@) ]]; then
    REPO_URL="${REPO_SPEC}"
  else
    REPO_URL="https://github.com/${REPO_SPEC}.git"
  fi
  SLUG="$(slugify "${REPO_URL}")"
  WORKSPACES="${HOST_ROOT}/.org/workspaces"
  TARGET_DIR="${WORKSPACES}/${SLUG}"
  ensure_repo_dir "${TARGET_DIR}" "${REPO_URL}"
fi

case "${MODE}" in
  tmux|console) ;;
  *) echo "ERROR: --ui must be tmux or console"; exit 2 ;;
esac

# We intentionally pass env to the container to disable nested sandboxing
# and to suppress the internal tmux heredoc writer.
exec podman run --rm -it \
  -v "${TARGET_DIR}:/work" -w /work \
  -e SANDBOX_BACKEND="${SANDBOX_BACKEND:-none}" \
  -e ORG_SANDBOX_BACKEND="${ORG_SANDBOX_BACKEND:-none}" \
  -e ORG_EXTERNAL_TMUX_BOOTSTRAP=1 \
  "${IMAGE}" org --ui "${MODE}"
