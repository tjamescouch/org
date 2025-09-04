#!/usr/bin/env bash
# scripts/install-org-binaries.sh
# Install the org launcher and its libexec helpers into system paths.

set -Eeuo pipefail

install -D -m 0755 "scripts/org"                "/usr/local/bin/org"
install -D -m 0755 "scripts/org-launch-tmux"    "/usr/local/libexec/org/launch-tmux"
install -D -m 0755 "scripts/org-launch-console" "/usr/local/libexec/org/launch-console"

# normalize line endings defensively
sed -i 's/\r$//' /usr/local/bin/org /usr/local/libexec/org/launch-tmux /usr/local/libexec/org/launch-console

echo "Installed: /usr/local/bin/org and /usr/local/libexec/org/{launch-tmux,launch-console}"
