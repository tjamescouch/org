#!/usr/bin/env bash
# org-sync-scripts.sh — copy project scripts into /scripts if present.
set -Eeuo pipefail
shopt -s nullglob

DEST="/scripts"
mkdir -p "$DEST"

# Search common layouts in priority order
CANDIDATES=(
  "/project/org/scripts"
  "/project/scripts"
  "/project/.org/scripts"
)

SYNCED=0
for SRC in "${CANDIDATES[@]}"; do
  if [[ -d "$SRC" ]]; then
    rsync -a --delete "$SRC"/ "$DEST"/
    # Ensure .sh are executable
    find "$DEST" -type f -name "*.sh" -exec chmod +x {} +
    echo "org-sync-scripts: synced from $SRC -> $DEST"
    SYNCED=1
    break
  fi
done

if [[ $SYNCED -eq 0 ]]; then
  echo "org-sync-scripts: no scripts directory found in project; leaving /scripts as-is." >&2
fi

exit 0
