#!/usr/bin/env bash
set -euo pipefail

# Name of the output zip file
OUTPUT="repo-archive.zip"

# Create the zip from tracked files only
git ls-files | zip -@ "$OUTPUT"

echo "Created $OUTPUT containing only git-tracked files."

