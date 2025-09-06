#!/usr/bin/env bash
# Apply a unified diff patch to the host repo safely with a backup ref + stash.
# Usage: scripts/patch-apply.sh [--project DIR] [--patch FILE]
set -Eeuo pipefail

PROJECT="$PWD"
PATCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--project) PROJECT="$2"; shift 2;;
    -p|--patch)   PATCH="$2";   shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

if [[ -z "$PATCH" ]]; then
  if [[ -f "${PROJECT}/.org/last-session.patch" ]]; then
    PATCH="${PROJECT}/.org/last-session.patch"
  else
    echo "No patch file specified and .org/last-session.patch not found." >&2
    exit 2
  fi
fi

cd "${PROJECT}"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  git init -q
fi
git config user.email "${GIT_AUTHOR_EMAIL:-org@example.com}"
git config user.name  "${GIT_AUTHOR_NAME:-org}"

bakRef="org.bak.$(date +%Y%m%d%H%M%S)"
git branch --quiet "${bakRef}" HEAD >/dev/null 2>&1 || true

stashRef=""
if git diff --quiet --no-ext-diff && git diff --quiet --no-ext-diff --cached; then
  : # clean
else
  git stash push --include-untracked -m "${bakRef}" >/dev/null 2>&1 || true
  stashRef="$(git stash list | awk -v m="${bakRef}" 'index($0,m){print $1; exit}')"
fi

set +e
git apply --index --reject --allow-binary-replacement --whitespace=nowarn "${PATCH}"
code=$?
set -e

if [[ $code -eq 0 ]]; then
  if ! git diff --cached --quiet --no-ext-diff; then
    git commit -m "org: apply session patch" --no-verify
  fi
  git branch -D "${bakRef}" >/dev/null 2>&1 || true
  echo "Patch applied successfully."
  exit 0
fi

echo "Apply failed; rolling back..."
git reset --hard "${bakRef}" || true
if [[ -n "${stashRef}" ]]; then
  git stash pop --index "${stashRef}" || true
fi
find . -name '*.rej' -type f -delete || true
echo "Restored working tree. Backup branch left at ${bakRef}."
exit 1
