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


# --- Bun (pinned) ------------------------------------------------------------
ARG BUN_VERSION=1.1.20
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64)  bun_arch="x64" ;; \
      arm64)  bun_arch="aarch64" ;; \
      *) echo "unsupported arch: $arch" && exit 1 ;; \
    esac; \
    tag="bun-v${BUN_VERSION}"; \
    base="https://github.com/oven-sh/bun/releases/download/${tag}"; \
    # pick the first asset that exists (aarch64 preferred on arm64)
    asset=""; \
    for name in "bun-linux-${bun_arch}.zip" "bun-linux-${arch}.zip"; do \
      if curl -fsSLI "${base}/${name}" >/dev/null 2>&1; then asset="$name"; break; fi; \
    done; \
    [ -n "$asset" ] || { echo "no Bun asset found for arch=$arch"; exit 1; }; \
    curl -fsSL "${base}/${asset}" -o /tmp/bun.zip; \
    unzip -q /tmp/bun.zip -d /tmp; \
    # the zip contains a single file named bun-linux-<arch>
    mv /tmp/bun-linux-* /usr/local/bin/bun; \
    chmod +x /usr/local/bin/bun; \
    rm -rf /tmp/bun.zip /tmp/bun-linux-*; \
    bun --version

