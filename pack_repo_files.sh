#!/bin/bash
# pack_repo_files.sh
# Usage: ./pack_repo_files.sh > repo-pack.txt
DELIM="=====FILE_DELIMITER====="
# Ensure we’re at the root of your repo
cd "$(git rev-parse --show-toplevel)" || exit 1
for f in $(git ls-files); do
  echo "$f"
  cat "$f"
  echo "$DELIM"
done

