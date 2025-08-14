#!/bin/bash
# Extracts the most recently modified org-main-*.zip file from ~/Downloads,
# copies its contents into the current working directory, and cleans up.
# Usage: run from the root of your project (e.g. org-main) to update files.

set -euo pipefail

# Find the newest org-main zip in ~/Downloads
zip_file=$(ls -1t "$HOME"/Downloads/org-main-*.zip 2>/dev/null | head -n 1 || true)

if [[ -z "$zip_file" ]]; then
  echo "No org-main-*.zip found in \$HOME/Downloads" >&2
  exit 1
fi

echo "Using archive: $zip_file"

# Create a temporary extraction directory
temp_dir=$(mktemp -d)

# Ensure cleanup happens even if the script exits early
cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

# Unzip into the temporary directory
unzip -q "$zip_file" -d "$temp_dir"

# Determine the top-level directory name (should be org-main)
extracted_dir=$(find "$temp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)

if [[ ! -d "$extracted_dir" ]]; then
  echo "Unexpected archive structure" >&2
  exit 1
fi

# Copy the contents into the current working directory
cp -R "$extracted_dir"/. .

echo "Extraction complete. Files copied to $(pwd)"
