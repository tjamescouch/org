#!/usr/bin/env bash
# org-sync-scripts.sh — copy project org/scripts → /scripts at runtime (no rebuilds).
set -Eeuo pipefail
shopt -s nullglob

SRC_DEFAULT="/project/org/scripts"
SRC="${ORG_SCRIPTS_SRC:-$SRC_DEFAULT}"
DEST="/scripts"

mkdir -p "$DEST"

if [[ -d "$SRC" ]]; then
  rsync -a --delete "$SRC"/ "$DEST"/
  # Ensure executability for .sh files
  find "$DEST" -type f -name "*.sh" -exec chmod +x {} +
  exit 0
fi

# Optional fallback: accept /project/scripts/org as an alternative layout
ALT="/project/scripts/org"
if [[ -d "$ALT" ]]; then
  rsync -a --delete "$ALT"/ "$DEST"/
  find "$DEST" -type f -name "*.sh" -exec chmod +x {} +
  exit 0
fi

echo "org-sync-scripts: no org/scripts found in project; leaving existing /scripts as-is." >&2
exit 0
