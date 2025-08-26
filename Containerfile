FROM debian:12-slim

ENV ORG_BIN=/work/.org/bin
ENV PATH="${ORG_BIN}:${PATH}"
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
    arch="$(dpkg --print-architecture)"; echo "dpkg arch=$arch"; \
    case "$arch" in amd64) bun_arch="x64" ;; arm64) bun_arch="aarch64" ;; *) echo "unsupported: $arch"; exit 1;; esac; \
    tag="bun-v${BUN_VERSION}"; base="https://github.com/oven-sh/bun/releases/download/${tag}"; \
    url="${base}/bun-linux-${bun_arch}.zip"; echo "URL=$url"; \
    curl -fsSL "$url" -o /tmp/bun.zip; \
    unzip -q /tmp/bun.zip -d /tmp; \
    # pick source: either a file or bun inside the dir
    if [ -f "/tmp/bun-linux-${bun_arch}" ]; then src="/tmp/bun-linux-${bun_arch}"; \
    elif [ -f "/tmp/bun-linux-${bun_arch}/bun" ]; then src="/tmp/bun-linux-${bun_arch}/bun"; \
    else echo "bun binary not found in zip"; ls -R /tmp; exit 1; fi; \
    install -m 0755 "$src" /usr/local/bin/bun; \
    rm -rf /tmp/bun.zip "/tmp/bun-linux-${bun_arch}"; \
    uname -m; dpkg --print-architecture; file /usr/local/bin/bun; \
    /usr/local/bin/bun --version

