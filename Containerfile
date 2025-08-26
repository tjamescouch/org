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


# --- Bun (pin version; install to /usr/local/bin) ----------------------------
ARG BUN_VERSION=1.1.20
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) bun_arch="x64" ;; \
      arm64) bun_arch="aarch64" ;; \
      *) echo "unsupported arch: $arch" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/v${BUN_VERSION}/bun-linux-${bun_arch}.zip" -o /tmp/bun.zip; \
    unzip -q /tmp/bun.zip -d /tmp; \
    mv "/tmp/bun-linux-${bun_arch}" /usr/local/bin/bun; \
    chmod +x /usr/local/bin/bun; \
    rm -rf /tmp/bun.zip; \
    bun --version

