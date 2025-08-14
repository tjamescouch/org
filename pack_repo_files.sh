#!/bin/bash
# pack_repo_files.sh
# Usage: ./pack_repo_files.sh > repo-pack.txt
set -euo pipefail

DELIM="=====FILE_DELIMITER====="

# Ensure we're at repo root
cd "$(git rev-parse --show-toplevel)"

git ls-files | while IFS= read -r f; do
  printf '%s\n' "$f"            # path line
  cat -- "$f"                   # file contents
  printf '\n%s\n' "$DELIM"      # delimiter on its own line
done

