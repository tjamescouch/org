#!/usr/bin/env bash
# Ensure we are in the correct workspace directory
WORKSPACE_DIR="${HOME}/dev/ai-workspace"
if [[ ! -d "$WORKSPACE_DIR" ]]; then
  echo "Workspace directory $WORKSPACE_DIR does not exist. Creating it..."
  mkdir -p "$WORKSPACE_DIR"
fi
cd "$WORKSPACE_DIR" || { echo "Failed to change directory to $WORKSPACE_DIR"; exit 1; }
# Rest of org script logic goes here
echo "Running org in $(pwd)"
