#!/usr/bin/env bash
# install.sh: installs org and apply_patch into /usr/local/bin

set -euo pipefail

ROOTDIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure apply_patch exists
if [[ ! -f "$ROOTDIR/apply_patch" ]]; then
  echo "install.sh: apply_patch not found in project root" >&2
  exit 1
fi

# Install apply_patch globally
sudo install -m 0755 "$ROOTDIR/apply_patch" /usr/local/bin/apply_patch
echo "[install.sh] Installed apply_patch -> /usr/local/bin/apply_patch"

# Install org globally
sudo install -m 0755 "$ROOTDIR/org" /usr/local/bin/org
echo "[install.sh] Installed org -> /usr/local/bin/org"

echo "[install.sh] Done. You can now run 'org' from anywhere."

