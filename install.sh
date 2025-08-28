#!/usr/bin/env bash
# Unified installer for org
# - Detects engine (podman|docker)
# - Builds image only if missing (or --rebuild)
# - Installs a runnable `org` on your PATH via symlink
# - Works on Debian/Ubuntu and macOS

set -euo pipefail

# -----------------------
# Pretty logging helpers
# -----------------------
note() { printf '[install] %s\n' "$*"; }
ok()   { printf '[install] done. %s\n' "$*" ; }
warn() { printf '[install][warn] %s\n' "$*" >&2; }
err()  { printf '[install][error] %s\n' "$*" >&2; }

# -----------------------
# Parse flags
# -----------------------
REBUILD=0
ENGINE_OVERRIDE=""
IMAGE_OVERRIDE=""
while (($#)); do
  case "$1" in
    --rebuild) REBUILD=1; shift;;
    --engine=*) ENGINE_OVERRIDE="${1#*=}"; shift;;
    --image=*)  IMAGE_OVERRIDE="${1#*=}"; shift;;
    -h|--help)
      cat <<'USAGE'
Usage: ./install.sh [--rebuild] [--engine=podman|docker] [--image=<tag>]

  --rebuild       Force container image rebuild.
  --engine=...    Override engine detection (podman|docker).
  --image=...     Override image tag (default: localhost/org-build:debian-12).

Examples:
  ./install.sh
  ./install.sh --rebuild
  ./install.sh --engine=podman --image=localhost/org-build:debian-12
USAGE
      exit 0;;
    *)
      warn "unknown flag $1 (ignored)"; shift;;
  esac
done

# -----------------------
# Paths & repo root
# -----------------------
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORG_BIN="$REPO/org"
CONTEXT="$REPO"
FILE="$REPO/Containerfile"

if [[ ! -f "$ORG_BIN" ]]; then
  err "cannot find launcher at $ORG_BIN"
  exit 66
fi
if [[ ! -f "$FILE" ]]; then
  err "cannot find Containerfile at $FILE"
  exit 66
fi

# Optional: project patch helper (not required to install)
if [[ ! -x "$REPO/.org/bin/apply_patch" ]]; then
  note "optional: no project patch helper at .org/bin/apply_patch (using image fallback)"
fi

# -----------------------
# Engine detection
# -----------------------
detect_engine() {
  if [[ -n "$ENGINE_OVERRIDE" ]]; then
    echo "$ENGINE_OVERRIDE"
    return
  fi
  if command -v podman >/dev/null 2>&1; then
    echo "podman"; return
  fi
  if command -v docker >/dev/null 2>&1; then
    echo "docker"; return
  fi
  err "neither podman nor docker found in PATH"
  exit 127
}

ENGINE="$(detect_engine)"
IMAGE="${IMAGE_OVERRIDE:-localhost/org-build:debian-12}"

note "engine = $ENGINE"
note "image  = $IMAGE"
note "file   = $(basename "$FILE")"

# -----------------------
# Image presence check
# -----------------------
image_exists() {
  case "$ENGINE" in
    podman) podman images -q "$IMAGE" 2>/dev/null | grep -q . ;;
    docker) docker images -q "$IMAGE" 2>/dev/null | grep -q . ;;
    *) return 1 ;;
  esac
}

# -----------------------
# Build image if needed
# -----------------------
if (( REBUILD )) || ! image_exists; then
  note "building image (this can take a few minutes)…"
  case "$ENGINE" in
    podman) podman build -t "$IMAGE" -f "$FILE" "$CONTEXT" ;;
    docker) docker build -t "$IMAGE" -f "$FILE" "$CONTEXT" ;;
  esac
  ok "image built"
else
  note "image already present; skipping build (use --rebuild to force)"
fi

# -----------------------
# Choose install dir for the `org` shim (symlink)
# -----------------------
UNAME="$(uname -s || echo unknown)"
DEFAULT_DIR="/usr/local/bin"

if [[ "$UNAME" == "Darwin" ]]; then
  # Prefer Homebrew bin if present (Apple Silicon often uses /opt/homebrew/bin)
  if [[ -d "/opt/homebrew/bin" ]]; then
    DEFAULT_DIR="/opt/homebrew/bin"
  fi
fi

link_into_dir() {
  local dir="$1"
  mkdir -p "$dir"
  ln -sf "$ORG_BIN" "$dir/org"
}

# Try system-wide first, else fallback to ~/.local/bin
if link_into_dir "$DEFAULT_DIR" 2>/dev/null; then
  ok "installed: $DEFAULT_DIR/org -> $ORG_BIN"
else
  warn "cannot write $DEFAULT_DIR (no sudo?): attempting user bin (~/.local/bin)"
  USER_BIN="$HOME/.local/bin"
  mkdir -p "$USER_BIN"
  if link_into_dir "$USER_BIN" 2>/dev/null; then
    ok "installed: $USER_BIN/org -> $ORG_BIN"
    # Ensure PATH info is obvious
    case ":$PATH:" in
      *":$USER_BIN:"*) ;;
      *)
        warn "Your PATH does not include $USER_BIN"
        printf '%s\n' \
          "[install] Add this to your shell rc (e.g., ~/.bashrc):" \
          "  export PATH=\"\$HOME/.local/bin:\$PATH\"" \
          "Then open a new shell or run:  source ~/.bashrc"
        ;;
    esac
    printf '%s\n' \
      "[install] If you prefer a system-wide link, run:" \
      "  sudo ln -sf \"$ORG_BIN\" \"$DEFAULT_DIR/org\""
  fi
fi

# -----------------------
# Final hint
# -----------------------
printf '\n'
note "Try:"
printf '  %s\n' "org --ui console --prompt 'say hi'"
printf '  %s\n' "org --ui tmux    --prompt 'say hi'"
printf '\n'
ok "installation complete"
