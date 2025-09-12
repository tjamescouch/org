#!/usr/bin/env bash
# Apply an org session patch to the current repo (host-side).
# Usage:
#   org apply               # applies latest .org/runs/*/session.patch
#   org apply --patch PATH  # applies a specific patch file
#   org apply -C <repo>     # choose project dir (or use ORG_PROJECT_DIR)

set -Eeuo pipefail

PROJECT="${ORG_PROJECT_DIR:-$PWD}"
PATCH=""
COMMIT_ENABLED="${ORG_COMMIT_ENABLED:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--project) PROJECT="$2"; shift 2 ;;
    --patch)      PATCH="$2";   shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: org apply [--patch <file>] [-C <repo>]
Applies an org session patch to the repo. By default uses the latest .org/runs/*/session.patch.
Commit is controlled by ORG_COMMIT_ENABLED=1/true/yes; default is not to commit.
EOF
      exit 0
      ;;
    *) echo "[org] unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -d "$PROJECT" ]] || { echo "[org] project not found: $PROJECT" >&2; exit 2; }

if [[ -z "$PATCH" ]]; then
  RUN="$(ls -d "$PROJECT"/.org/runs/* 2>/dev/null | sort | tail -1 || true)"
  [[ -n "$RUN" ]] || { echo "[org] no runs under $PROJECT/.org/runs" >&2; exit 3; }
  PATCH="$RUN/session.patch"
fi
[[ -f "$PATCH" ]] || { echo "[org] patch not found: $PATCH" >&2; exit 3; }

# Preflight & apply using index-aware flags (per Architecture docs).
git -C "$PROJECT" apply --index --whitespace=nowarn --check "$PATCH"
git -C "$PROJECT" apply --index --whitespace=nowarn "$PATCH"

# Optional commit (default off).
if [[ "$COMMIT_ENABLED" =~ ^([Tt][Rr][Uu][Ee]|1|[Yy][Ee][Ss])$ ]]; then
  git -C "$PROJECT" commit -m "Apply org session patch" --no-gpg-sign
  echo "[org] Patch applied and committed."
else
  echo "[org] Patch applied (staged). Not committed (set ORG_COMMIT_ENABLED=1 to commit)."
fi
