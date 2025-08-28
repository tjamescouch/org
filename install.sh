#!/usr/bin/env bash
# Unified installer for org
# - Builds/pulls the container image if needed
# - Installs a host-side launcher symlink
# - Prints clear guidance when /usr/local/bin isn't writable
set -Eeuo pipefail

# ---------------------------
# Detect container engine
# ---------------------------
if command -v podman >/dev/null 2>&1; then
  ENGINE="${ORG_ENGINE:-podman}"
elif command -v docker >/dev/null 2>&1; then
  ENGINE="${ORG_ENGINE:-docker}"
else
  echo "[install][error] neither podman nor docker found in PATH." >&2
  exit 127
fi

# ---------------------------
# Image + build file
# ---------------------------
IMAGE="${ORG_IMAGE:-localhost/org-build:debian-12}"
FILE="${ORG_CONTAINERFILE:-Containerfile}"

echo "[install] engine = $ENGINE"
echo "[install] image  = $IMAGE"
echo "[install] file   = $FILE"

# ---------------------------
# Build image if missing
# ---------------------------
if "$ENGINE" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[install] image already present; skipping build"
else
  echo "[install] building image (this can take a while)..."
  "$ENGINE" build -t "$IMAGE" -f "$FILE" .
  echo "[install] done. image built"
fi

# ---------------------------
# Host launcher symlink
# ---------------------------
REPO_DIR="$(pwd)"
SRC="$REPO_DIR/org"

if [ ! -x "$SRC" ]; then
  echo "[install][error] launcher not found or not executable at: $SRC" >&2
  echo "  Make sure you're running this from the repo root where 'org' lives." >&2
  exit 66
fi

# Prefer a system-wide link, then gracefully fall back to user bin on permission error.
if ln -sf "$SRC" /usr/local/bin/org 2>/dev/null; then
  echo "[install] installed: /usr/local/bin/org -> $SRC"
else
  echo "[install][warn] cannot write /usr/local/bin (no sudo?)."
  echo "[install] installing to user bin: ~/.local/bin"

  mkdir -p "$HOME/.local/bin"
  ln -sf "$SRC" "$HOME/.local/bin/org"
  echo "[install] installed: $HOME/.local/bin/org -> $SRC"

  # Reassure user + how to use immediately
  if ! command -v org >/dev/null 2>&1; then
    echo
    echo "[install][hint] Your shell may not have \$HOME/.local/bin on PATH yet."
    echo "  For this shell session, run:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo
    echo "  To make it persistent, add that line to your shell RC (e.g. ~/.bashrc or ~/.zshrc)."
  fi

  echo
  echo "[install] If you prefer a system-wide link later, run:"
  echo "  sudo ln -sf \"$SRC\" \"/usr/local/bin/org\""
fi

# ---------------------------
# Final friendly nudge
# ---------------------------
echo
echo "[install] Try:"
echo "  org --ui console --prompt 'say hi'"
echo "  org --ui tmux   --prompt 'say hi'"
echo
echo "[install] done. installation complete"