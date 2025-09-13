#!/usr/bin/env bash

# Exit on any error
set -e

# Update package index
if command -v sudo >/dev/null; then
  echo "Updating package index with sudo..."
  sudo apt update
else
  echo "Updating package index..."
  apt update
fi

# Install asciinema
if command -v sudo >/dev/null; then
  echo "Installing asciinema with sudo..."
  sudo apt install -y asciinema
else
  echo "Installing asciinema..."
  apt install -y asciinema
fi

# Verify installation
if command -v asciinema >/dev/null; then
  echo "asciinema installed successfully: $(asciinema --version)"
else
  echo "Installation failed or asciinema not found in PATH."
  exit 1
fi
