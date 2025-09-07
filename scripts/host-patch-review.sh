#!/usr/bin/env bash
# Host-side patch review & apply (opt-in).
# Deterministic: no fallbacks. Requires explicit --patch and --project.

set -Eeuo pipefail
set -v

usage() {
  cat >&2 <<'USAGE'
Usage:
  host-patch-review.sh --patch <patch-path> --project <repo-root>

Behavior:
  - Shows the patch in a pager (delta if available, else less -R).
  - On "y" approval, runs:
        git -C <repo-root> apply --index --whitespace=nowarn <patch>
  - Leaves commit to the user (or a later PR).

Flags:
  --patch     Absolute path to the patch file on the host.
  --project   Absolute path to the git project root (host).
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

# ---- Validate inputs (no guessing) ----
[[ -n "$PATCH"   ]] || { echo "host-patch-review: --patch is required" >&2; exit 2; }
[[ -n "$PROJECT" ]] || { echo "host-patch-review: --project is required" >&2; exit 2; }
[[ -f "$PATCH"   ]] || { echo "host-patch-review: patch not found: $PATCH" >&2; exit 2; }
git -C "$PROJECT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "host-patch-review: not a git repo: $PROJECT" >&2; exit 2; }

echo "[host-review] project = $PROJECT"
echo "[host-review] patch   = $PATCH"
echo

# ---- Show patch (read-only) ----
if command -v delta >/dev/null 2>&1; then
  delta -s --paging=always "$PATCH"
else
  less -R "$PATCH"
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
