#!/usr/bin/env bash
# Copy the project's canonical scripts dir into /scripts (DEV only).
# Single source of truth: /project/scripts (no alternate paths).
set -Eeuo pipefail
shopt -s nullglob

SRC="/project/scripts"
DEST="/scripts"

if [[ ! -d "$SRC" ]]; then
  echo "org-sync-scripts: /project/scripts not found; skipping sync." >&2
  exit 0
fi

mkdir -p "$DEST"
rsync -a --delete "$SRC"/ "$DEST"/
# Ensure shell scripts are executable
find "$DEST" -type f -name "*.sh" -exec chmod +x {} +
echo "org-sync-scripts: synced /project/scripts -> /scripts"
