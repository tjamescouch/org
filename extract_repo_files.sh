#!/bin/bash
# extract_repo_files.sh
#
# Find and extract the most recent `org-main-<timestamp>.zip` archive from your
# Downloads folder, and apply its contents to the current working directory.
#
# This script scans `$HOME/Downloads` for zip archives named `org-main-<timestamp>.zip`,
# selects the one with the largest numeric timestamp, unpacks it into a temporary
# directory, then copies its contents into the current directory, overwriting existing
# files.  After running this script, a `git status` in your repository should show
# the updates as if you had just pulled/pushed those files.
#
# Usage: ./extract_repo_files.sh

set -euo pipefail

# Find the most recent `org-main-<timestamp>.zip` file in the user's Downloads directory.
# This matches filenames like org-main-1234567890.zip and picks the one with the largest
# numeric timestamp.  We avoid matching files like "org-main (1).zip".
downloads_dir="$HOME/Downloads"
latest_zip=""
latest_ts=0
shopt -s nullglob
for z in "$downloads_dir"/org-main-*.zip; do
  # Only consider files that actually exist
  [[ -e "$z" ]] || continue
  # Extract the numeric timestamp between "org-main-" and ".zip"
  ts="${z##*/org-main-}"
  ts="${ts%.zip}"
  # Ensure the timestamp is numeric
  if [[ "$ts" =~ ^[0-9]+$ ]]; then
    if [[ -z "$latest_zip" || "$ts" -gt "$latest_ts" ]]; then
      latest_zip="$z"
      latest_ts="$ts"
    fi
  fi
done
shopt -u nullglob

if [[ -z "$latest_zip" ]]; then
  echo "Error: No org-main-<timestamp>.zip files found in $downloads_dir." >&2
  exit 1
fi

echo "Using archive: $latest_zip"

# Create a temporary directory for extraction
tmp_extract=$(mktemp -d)
trap 'rm -rf "$tmp_extract"' EXIT

echo "Extracting archive into temporary directory..."
unzip -q "$latest_zip" -d "$tmp_extract"

# Determine top-level extracted directory (e.g. org-main)
top_level_dir=$(ls -1 "$tmp_extract" | head -n 1)
if [[ -z "$top_level_dir" ]]; then
  echo "Error: Unexpected archive structure." >&2
  exit 1
fi

# Copy the contents of the extracted directory into the current working directory,
# preserving attributes and overwriting existing files.
echo "Applying files to current working directory..."
cp -a "$tmp_extract/$top_level_dir/." .

echo "Extraction complete. The current directory has been updated."
