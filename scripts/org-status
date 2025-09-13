#!/usr/bin/env bash
# Show pending org patch summary and current staged files.
# Usage:
#   org status
#   org status -C <repo>

set -Eeuo pipefail

PROJECT="${ORG_PROJECT_DIR:-$PWD}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--project) PROJECT="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: org status [-C <repo>]
Shows:
- Pending org patch (latest .org/runs/*/session.patch), whether it applies cleanly,
  and a summary of file changes in the patch.
- Staged files currently in the repo (git index).
EOF
      exit 0 ;;
    *) echo "[org] unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -d "$PROJECT" ]] || { echo "[org] project not found: $PROJECT" >&2; exit 2; }

RUN="$(ls -d "$PROJECT"/.org/runs/* 2>/dev/null | sort | tail -1 || true)"
if [[ -z "$RUN" ]]; then
  echo "[org] No runs found under $PROJECT/.org/runs"
  exit 0
fi

PATCH="$RUN/session.patch"
if [[ ! -s "$PATCH" ]]; then
  echo "[org] Latest run has no patch (or empty): $PATCH"
  exit 0
fi

echo "[org] Latest patch: $PATCH"
# Check if it applies cleanly (won't modify the repo).
if git -C "$PROJECT" apply --index --whitespace=nowarn --check "$PATCH" >/dev/null 2>&1; then
  echo "[org] Preflight: applies cleanly."
else
  echo "[org] Preflight: WOULD NOT apply cleanly. (Resolve conflicts or re-run.)"
fi

echo
echo "— Patch summary —"
# A compact summary without changing anything (create/delete/rename + counts).
git -C "$PROJECT" apply --summary --numstat "$PATCH" | sed -e 's/^/  /'

echo
echo "— Staged files in repo (index) —"
# What is currently staged in your working repo.
if ! git -C "$PROJECT" diff --cached --name-status | sed -e 's/^/  /'; then
  echo "  (none)"
fi
