#!/usr/bin/env bash
# Populate /work from /project once (fast, no overlayfs). Subsequent runs keep user edits in /work.
set -Eeuo pipefail

WORK="/work"
PROJ="/project"
SENTINEL="${WORK}/.org/.populated"

mkdir -p "${WORK}/.org"

if [[ -f "$SENTINEL" ]]; then
  exit 0
fi

# First-time populate; exclude .org runtime artifacts and VCS metadata.
rsync -a --delete \
  --exclude ".org/**" \
  --exclude ".git/**" \
  "${PROJ}/" "${WORK}/"

date -Is > "$SENTINEL"
