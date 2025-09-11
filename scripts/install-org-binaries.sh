#!/usr/bin/env bash
# scripts/install-org-binaries.sh
# Install the org wrapper and its two launchers into system paths.
# Works no matter where it's run from (image build or host).

set -Eeuo pipefail

# Resolve the directory this script lives in (robust to symlinks)
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

# Verify the payload exists
for f in org org-launch-tmux org-launch-console org-launch-rich; do
  if [[ ! -f "$DIR/$f" ]]; then
    echo "ERROR: missing $DIR/$f (expected next to this installer)" >&2
    exit 1
  fi
done

# Install
install -D -m 0755 "$DIR/org"                "/usr/local/bin/org"
install -D -m 0755 "$DIR/org-launch-tmux"    "/usr/local/libexec/org/launch-tmux"
install -D -m 0755 "$DIR/org-launch-rich"    "/usr/local/libexec/org/launch-rich"
install -D -m 0755 "$DIR/org-launch-console" "/usr/local/libexec/org/launch-console"

# Normalize line endings defensively
sed -i 's/\r$//' \
  /usr/local/bin/org \
  /usr/local/libexec/org/launch-tmux \
  /usr/local/libexec/org/launch-rich \
  /usr/local/libexec/org/launch-console

echo "Installed: /usr/local/bin/org and /usr/local/libexec/org/{launch-tmux,launch-console}"
