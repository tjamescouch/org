#!/usr/bin/env bash
# Unified installer for org (Linux/macOS).
# - Builds container image only if missing (or --rebuild)
# - No longer requires ./apply_patch at repo root
# - Prefers podman; set ORG_ENGINE=docker to use Docker
# - Safe pulls: --pull=missing (won't repull if cached)

set -euo pipefail

# -----------------------------
# Config (overridable via env)
# -----------------------------
ENGINE="${ORG_ENGINE:-podman}"                         # podman | docker
IMAGE="${ORG_IMAGE:-localhost/org-build:debian-12}"    # final image tag
CONTAINERFILE="${ORG_CONTAINERFILE:-Containerfile}"    # path to Containerfile
LINK_BIN=1                                             # create /usr/local/bin/org symlink
REBUILD=0

# -----------------------------
# Args
# -----------------------------
while (($#)); do
  case "$1" in
    --engine=*) ENGINE="${1#*=}"; shift;;
    --image=*)  IMAGE="${1#*=}"; shift;;
    --file=*)   CONTAINERFILE="${1#*=}"; shift;;
    --no-link)  LINK_BIN=0; shift;;
    --rebuild)  REBUILD=1; shift;;
    -h|--help)
      cat <<EOF
Usage: ./install.sh [options]

Options:
  --engine=podman|docker     Container engine (default: podman)
  --image=<tag>              Image tag (default: localhost/org-build:debian-12)
  --file=<Containerfile>     Build file (default: Containerfile)
  --rebuild                  Force a rebuild even if image exists
  --no-link                  Don't create /usr/local/bin/org symlink
  -h, --help                 Show this help
EOF
      exit 0;;
    *)
      echo "[install][warn] unknown arg: $1" >&2; shift;;
  esac
done

# -----------------------------
# Helpers
# -----------------------------
say() { printf '[install] %s\n' "$*"; }
die() { printf '[install][error] %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }

engine() { "$ENGINE" "$@"; }

image_exists() {
  case "$ENGINE" in
    podman) engine image exists "$IMAGE" >/dev/null 2>&1 ;;
    docker) engine image inspect "$IMAGE" >/dev/null 2>&1 ;;
    *) die "unknown engine: $ENGINE" ;;
  esac
}

ensure_podman_machine() {
  # macOS only: start/init podman machine if needed
  if [[ "$(uname -s)" == "Darwin" && "$ENGINE" == "podman" ]]; then
    if ! command -v podman-machine >/dev/null 2>&1; then
      # Newer podman bundles subcommand as "podman machine"
      if podman machine ls >/dev/null 2>&1; then
        :
      else
        die "Podman is installed but 'podman machine' is unavailable. Reinstall Podman Desktop or brew install podman."
      fi
    fi
    state="$(podman machine inspect --format '{{.State}}' default 2>/dev/null || true)"
    if [[ -z "$state" ]]; then
      say "initializing podman machine (first run)…"
      podman machine init
    fi
    if [[ "$state" != "running" ]]; then
      say "starting podman machine…"
      podman machine start
    fi
  fi
}

# -----------------------------
# Preflight
# -----------------------------
need git
need "$ENGINE"
[[ -f "$CONTAINERFILE" ]] || die "Containerfile not found at: $CONTAINERFILE"

ensure_podman_machine

say "engine = $ENGINE"
say "image  = $IMAGE"
say "file   = $CONTAINERFILE"

# -----------------------------
# Project layout (no hard reqs)
# -----------------------------
mkdir -p .org/logs .org/bin

# NOTE: We no longer require ./apply_patch in the repo.
# The container includes a portable /usr/local/bin/apply_patch that:
#   - defers to /work/.org/bin/apply_patch if you add one later
#   - otherwise accepts unified diffs from stdin or -f <file>

# -----------------------------
# Build (only if needed)
# -----------------------------
if [[ "$REBUILD" -eq 1 ]]; then
  say "forcing rebuild (--rebuild)…"
  engine build --pull=missing -t "$IMAGE" -f "$CONTAINERFILE" .
else
  if image_exists; then
    say "image already present; skipping build"
  else
    say "image not found; building…"
    engine build --pull=missing -t "$IMAGE" -f "$CONTAINERFILE" .
  fi
fi

# -----------------------------
# Optional host symlink
# -----------------------------
if [[ "$LINK_BIN" -eq 1 ]]; then
  target="/usr/local/bin/org"
  if [[ -w "$(dirname "$target")" ]]; then
    ln -sf "$(pwd)/org" "$target"
    say "linked $(pwd)/org -> $target"
  else
    say "cannot write $target; try:"
    echo "  sudo ln -sf \"$(pwd)/org\" \"$target\""
  fi
fi

say "done."
say "Try:  org --ui console --prompt 'say hi'"
