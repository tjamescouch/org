#!/usr/bin/env bash
# Host-side patch review & apply.
# Expects: --patch <patch-path> --project <repo-root>

set -Eeuo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  host-patch-review.sh --patch <patch-path> --project <repo-root>

Behavior:
  - Shows the patch in a pager (delta if available, else less -R).
  - Refuses to apply if the target repo has uncommitted changes.
  - On "y" approval, applies the patch with:
        git -C <repo-root> apply --index --whitespace=nowarn <patch>
  - Leaves committing to the user.
USAGE
}

PATCH=""
PROJECT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --patch)   PATCH="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "host-patch-review: unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$PATCH"   ]] || { echo "host-patch-review: --patch is required" >&2; exit 2; }
[[ -n "$PROJECT" ]] || { echo "host-patch-review: --project is required" >&2; exit 2; }
[[ -f "$PATCH"   ]] || { echo "host-patch-review: patch not found: $PATCH" >&2; exit 2; }

git -C "$PROJECT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "host-patch-review: not a git repo: $PROJECT" >&2; exit 2; }

echo "[host-review] project = $PROJECT"
echo "[host-review] patch   = $PATCH"
echo

# Require a clean repo (fail-fast)
if [[ -n "$(git -C "$PROJECT" status --porcelain)" ]]; then
  echo "[host-review] repo is dirty; please commit/stash/reset before applying a review patch."
  exit 1
fi

# ---- Show patch (read-only) ----
if command -v delta >/dev/null 2>&1; then
  delta -s --paging=always "$PATCH"
else
  less -R -K "$PATCH"
fi

# ---- Confirm & apply ----
read -r -p "Apply this patch to '$PROJECT'? [y/N] " ans
case "$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')" in
  y|yes)
    echo "[host-review] applying..."
    git -C "$PROJECT" apply --index --whitespace=nowarn --check "$PATCH"
    git -C "$PROJECT" apply --index --whitespace=nowarn "$PATCH"
    echo "[host-review] apply: OK"
    ;;
  *)
    echo "[host-review] skipped (no changes applied)."
    ;;
esac