#!/usr/bin/env bash
# Create a unified diff patch of changes under /work relative to its baseline.
set -Eeuo pipefail

OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    *) echo "usage: patch-create.sh --out /work/.org/last-session.patch" >&2; exit 2;;
  esac
done
[[ -n "$OUT" ]] || { echo "Missing --out"; exit 2; }

WORKDIR="/work"
mkdir -p "$(dirname "$OUT")"

# Ensure a baseline repo exists (non-git projects supported)
if ! git -C "$WORKDIR" rev-parse --git-dir >/dev/null 2>&1; then
  (
    cd "$WORKDIR"
    git init -q
    git config user.email "org@example.com"
    git config user.name  "org"
    git add -A || true
    git commit -qm "baseline" || true
  )
fi

tmp_patch="$(mktemp)"
set +e
git -C "$WORKDIR" \
  -c color.ui=false -c core.pager=cat --no-pager \
  diff --binary --no-ext-diff -- . ":(exclude).org/**" > "${tmp_patch}"
code=$?
set -e

if [[ ! -s "${tmp_patch}" ]]; then
  : > "${OUT}"
  echo "No changes to include in patch." >&2
  rm -f "${tmp_patch}"
  exit 0
fi

mv -f "${tmp_patch}" "${OUT}"
echo "Wrote patch to ${OUT}"
