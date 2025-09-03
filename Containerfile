# syntax=docker/dockerfile:1.4
FROM debian:12-slim
SHELL ["/bin/bash", "-lc"]

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    TERM=xterm-256color \
    ORG_BUN_BIN=/usr/local/bin/bun \
    ORG_TMUX_BIN=/usr/bin/tmux \
    ORG_DEFAULT_CWD=/work \
    ORG_HOST_ALIAS=host.containers.internal \
    ORG_OPENAI_BASE_DEFAULT=http://host.containers.internal:11434/v1 \
    NO_PROXY=localhost,127.0.0.1,::1,host.containers.internal,192.168.56.1 \
    PATH="/root/.bun/bin:/home/ollama/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Base packages + nice TTY UX
RUN set -euxo pipefail; \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      bash ca-certificates curl git rsync jq file \
      build-essential pkg-config cmake clang llvm lldb \
      python3 python3-pip python3-venv \
      nodejs npm \
      unzip zip tar xz-utils \
      tmux ncurses-term less locales \
      vim-nox && \
    rm -rf /var/lib/apt/lists/* && \
    sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen

# Install delta (optional)
ARG DELTA_VER=0.17.0
RUN set -euxo pipefail; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) rel='x86_64-unknown-linux-gnu' ;; \
    arm64) rel='aarch64-unknown-linux-gnu' ;; \
    i386)  rel='i686-unknown-linux-gnu' ;; \
    *)     exit 0 ;; \
  esac; \
  url="https://github.com/dandavison/delta/releases/download/${DELTA_VER}/delta-${DELTA_VER}-${rel}.tar.gz"; \
  curl -fsSL "$url" -o /tmp/delta.tgz; \
  tar -xzf /tmp/delta.tgz -C /tmp; \
  install -m0755 "/tmp/delta-${DELTA_VER}-${rel}/delta" /usr/local/bin/delta; \
  rm -rf /tmp/delta*

# Bun to a fixed, root-owned path
ARG BUN_VERSION=1.2.19
RUN set -euxo pipefail; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in amd64) bun_arch='x64' ;; arm64) bun_arch='aarch64' ;; *) echo "Unsupported arch: $arch" >&2; exit 1 ;; esac; \
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip" -o /tmp/bun.zip; \
  mkdir -p /tmp/bun; \
  unzip /tmp/bun.zip -d /tmp/bun >/dev/null; \
  install -m0755 "/tmp/bun/bun-linux-${bun_arch}/bun" /usr/local/bin/bun; \
  rm -rf /tmp/bun /tmp/bun.zip

# ---- Bake the org repo in the image ----
WORKDIR /opt/org
COPY . /opt/org

# A wrapper that always executes the baked tree and refreshes runtime files.
RUN install -d /usr/local/bin && cat > /usr/local/bin/org <<'EOF_ORG' && chmod +x /usr/local/bin/org
#!/usr/bin/env bash
set -Eeuo pipefail

WORK=${ORG_WORK:-/work}
RUNTIME_DIR="${WORK}/.org"
mkdir -p "$RUNTIME_DIR" "$RUNTIME_DIR/tmp"

# If you ship static tmux helpers, refresh them each run (optional).
if [[ -f /opt/org/assets/tmux/tmux-inner.sh ]]; then
  install -m0755 /opt/org/assets/tmux/tmux-inner.sh "$RUNTIME_DIR/tmux-inner.sh"
fi
if [[ -f /opt/org/assets/tmux/tmux.conf ]]; then
  install -m0644 /opt/org/assets/tmux/tmux.conf "$RUNTIME_DIR/tmux.conf"
fi

# Ensure the app sees the right tools from inside the container.
export ORG_BUN_BIN=${ORG_BUN_BIN:-/usr/local/bin/bun}
export ORG_TMUX_BIN=${ORG_TMUX_BIN:-/usr/bin/tmux}
export ORG_DEFAULT_CWD=${ORG_DEFAULT_CWD:-/work}
export ORG_PATCH_POPUP_CMD=${ORG_PATCH_POPUP_CMD:-bash -lc 'if test -f .org/last-session.patch; then (command -v delta >/dev/null && delta -s --paging=never .org/last-session.patch || (echo; echo "(delta not found; showing raw patch)"; echo; cat .org/last-session.patch)); else echo "No session patch found."; fi; echo; read -p "Enter to close..." _'}

exec /usr/local/bin/bun /opt/org/src/app.ts "$@"
EOF_ORG

# A robust apply_patch without heredocs
RUN install -D -m0755 /dev/null /usr/local/bin/apply_patch; \
  printf '%s\n' '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'WORK_ROOT="${ORG_WORK:-/work}"' \
  'PATCH_FILE=""' \
  'while [ $# -gt 0 ]; do' \
  '  case "$1" in' \
  '    -f|--file) PATCH_FILE="$2"; shift 2;;' \
  '    -) PATCH_FILE="-"; shift;;' \
  '    *) echo "apply_patch: unknown arg: $1" >&2; exit 2;;' \
  '  esac' \
  'done' \
  'tmp_patch="/tmp/ap.$$.patch"' \
  'if [ -z "$PATCH_FILE" ] || [ "$PATCH_FILE" = "-" ]; then cat > "$tmp_patch"; else cp "$PATCH_FILE" "$tmp_patch"; fi' \
  'mapfile -t paths < <(awk '\''/^diff --git a\\//{print $4}'\'' "$tmp_patch" | sed -E '\''s#^b/##'\'')' \
  'if [ "${#paths[@]}" -eq 0 ]; then echo "apply_patch: no paths in diff" >&2; exit 1; fi' \
  "deny='^(\\.git/|\\.org/|/|\\.{2}(/|$)|.*\\x00.*)'" \
  'viol=""; for p in "${paths[@]}"; do p="${p#./}"; [[ "$p" =~ $deny ]] && viol+="$p\n"; done' \
  'if [ -n "$viol" ]; then printf '\''apply_patch: path policy violations:\n%s'\'' "$viol" >&2; exit 3; fi' \
  'git -C "$WORK_ROOT" apply --index --whitespace=nowarn --check "$tmp_patch"' \
  'git -C "$WORK_ROOT" apply --index --whitespace=nowarn "$tmp_patch"' \
  'echo "apply_patch: OK"' \
  > /usr/local/bin/apply_patch

WORKDIR /work
