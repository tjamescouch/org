#!/usr/bin/env bash
# install.sh: install org + apply_patch using symlinks so org always points to repo.

set -euo pipefail
ROOTDIR="$(cd "$(dirname "$0")" && pwd)"

# Sanity checks
[[ -f "$ROOTDIR/org" ]]         || { echo "install.sh: missing ./org" >&2; exit 1; }
[[ -f "$ROOTDIR/runner.ts" ]]   || { echo "install.sh: missing ./runner.ts" >&2; exit 1; }
[[ -f "$ROOTDIR/apply_patch" ]] || { echo "install.sh: missing ./apply_patch" >&2; exit 1; }

# Make sure scripts are executable
chmod 0755 "$ROOTDIR/org" || true
chmod 0755 "$ROOTDIR/apply_patch" || true

# Install apply_patch (copy)
sudo install -m 0755 "$ROOTDIR/apply_patch" /usr/local/bin/apply_patch
echo "[install.sh] Installed apply_patch -> /usr/local/bin/apply_patch"

# Remove any stale org wrapper
sudo rm -f /usr/local/bin/org

# Install org as a symlink pointing back into the repo
sudo ln -s "$ROOTDIR/org" /usr/local/bin/org
echo "[install.sh] Symlinked org -> /usr/local/bin/org -> $ROOTDIR/org"

git config core.hooksPath .githooks
echo "git pre commit hook path added"
chmod +x .githooks/pre-commit
echo "git pre commit hook made executable"

echo "[install.sh] Done. Run 'org' from ANY directory; agents operate in that directory."
