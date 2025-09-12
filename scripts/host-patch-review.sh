#!/usr/bin/env bash
# Host-side patch review & apply.
# Viewers:
#   - default: less (Ctrl+C exits)
#   - vimdiff: side-by-side visual diff using a temp worktree (safe)
#
# Usage:
#   scripts/host-patch-review.sh --patch <file> --project <repo> [--viewer less|vimdiff]
#
# Or via env:
#   ORG_PATCH_VIEWER=vimdiff scripts/host-patch-review.sh --patch ... --project ...

set -Eeuo pipefail

PATCH=""
PROJECT=""
VIEWER="${ORG_PATCH_VIEWER:-less}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --patch)   PATCH="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --viewer)  VIEWER="$2";  shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: host-patch-review.sh --patch <file> --project <repo> [--viewer less|vimdiff]
       ORG_PATCH_VIEWER=vimdiff host-patch-review.sh --patch <file> --project <repo>

less    : shows the unified diff in a pager (press 'q' to close, Ctrl+C to abort).
vimdiff : opens a side-by-side visual diff in a temporary worktree; quit with :qa.
EOF
      exit 0
      ;;
    *) echo "[org] unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -f "$PATCH"   ]] || { echo "[org] patch not found: $PATCH" >&2; exit 2; }
[[ -d "$PROJECT" ]] || { echo "[org] project dir not found: $PROJECT" >&2; exit 2; }

trap 'echo; echo "[org] Aborted."; exit 130' INT

show_less() {
  if command -v less >/dev/null 2>&1; then
    export LESS='-K -R'  # -K: quit on Ctrl+C, -R: pass ANSI colors if present
    less -P '[org] Patch preview — press q to close; Ctrl+C to abort' "$PATCH" || true
  else
    ${PAGER:-more} "$PATCH" || true
  fi
}

show_vimdiff() {
  # Create an isolated preview worktree at HEAD
  local tmp base
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/org-review.XXXXXX")"
  cleanup() {
    # Remove the worktree even if user force-quit
    git -C "$PROJECT" worktree remove --force "$tmp" >/dev/null 2>&1 || true
    rm -rf "$tmp" >/dev/null 2>&1 || true
  }
  trap 'cleanup; exit 130' INT TERM

  git -C "$PROJECT" worktree add --detach "$tmp" HEAD >/dev/null
  base="$(git -C "$tmp" rev-parse HEAD)"

  # Preflight: will fail early if patch cannot apply
  git -C "$tmp" apply --index --whitespace=nowarn --check "$PATCH"

  # Apply to the temp worktree & make a single preview commit
  GIT_AUTHOR_NAME=org GIT_AUTHOR_EMAIL=org@local \
  GIT_COMMITTER_NAME=org GIT_COMMITTER_EMAIL=org@local \
    bash -lc "
      set -Eeuo pipefail
      git -C \"$tmp\" apply --index --whitespace=nowarn \"$PATCH\"
      git -C \"$tmp\" commit -m 'org review preview' --no-gpg-sign >/dev/null
    "

  # Open a directory diff in vimdiff without writing any global git config
  git -C "$tmp" \
    -c diff.tool=vimdiff -c difftool.prompt=false \
    difftool --dir-diff "$base" HEAD

  cleanup
}

case "${VIEWER}" in
  vimdiff) show_vimdiff ;;
  less|pager|*) show_less ;;
esac

# Ask whether to apply to the real repo
read -r -p "[org] Apply this patch to ${PROJECT}? [y/N] " ans
case "${ans:-}" in
  y|Y)
    git -C "$PROJECT" apply --index --whitespace=nowarn --check "$PATCH"
    git -C "$PROJECT" apply --index --whitespace=nowarn "$PATCH"

    _commit="${ORG_COMMIT_ENABLED:-}"

    if [[ "${_commit,,}" =~ ^(1|true|yes)$ ]]; then
      git -C "$PROJECT" commit -m "Apply org session patch" --no-gpg-sign
      echo "[org] Patch applied and committed."
    else
      echo "[org] Patch applied. (not committed; ORG_COMMIT_ENABLED is false)"
    fi
    ;;
  *)
    echo "[org] Patch skipped."
    ;;
esac
