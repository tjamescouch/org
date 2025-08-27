#!/bin/sh

# Clean rebuild (recommended while iterating)
podman build --no-cache --platform linux/arm64 \
  -t localhost/org-build:debian-12 -f Containerfile .

# Or just echo PATH at runtime
podman run --rm localhost/org-build:debian-12 \
  bash -lc 'echo "$PATH"'
# Expect to see /work/.org/bin at the front

