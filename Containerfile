FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive
# Core utilities the agents use
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git rsync jq file \
# C/C++ toolchain
    build-essential pkg-config cmake clang llvm lldb \
# Scripting / glue
    python3 python3-pip python3-venv \
    nodejs npm \
# Archive helpers
    unzip zip tar xz-utils \
 && rm -rf /var/lib/apt/lists/*
