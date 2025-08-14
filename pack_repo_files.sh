#!/bin/bash
# pack_repo_files.sh
# Create a single text file concatenating all git‑tracked files separated by a delimiter.
#
# Usage:
#   ./pack_repo_files.sh > repo-pack.txt
#
# The script iterates over all files tracked by git, writes the file path on
# its own line, the file contents, and then a delimiter.  Redirect its output
# to create a reproducible bundle for later extraction.

set -euo pipefail

# Choose a delimiter unlikely to appear in source files.
DELIM="=====FILE_DELIMITER====="

# Iterate over each file tracked by git
for file in $(git ls-files); do
  # Print the relative file path as the first line of this block
  printf '%s\n' "$file"
  # Print the file contents
  cat "$file"
  # Print a newline to ensure the delimiter is on its own line
  printf '\n'
  # Print the delimiter
  printf '%s\n' "$DELIM"
done
