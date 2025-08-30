FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive

# Base packages + a good TTY UX (tmux, vim-nox, less, locales)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git rsync jq file \
    build-essential pkg-config cmake clang llvm lldb \
    python3 python3-pip python3-venv \
    nodejs npm \
    unzip zip tar xz-utils \
    tmux ncurses-term less locales \
    vim-nox \
 && rm -rf /var/lib/apt/lists/*

# Locale for better readline/Unicode behavior
RUN sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Safe default TERM inside the container
ENV TERM=xterm-256color

# Install 'delta' (nice patch viewer)
ARG DELTA_VER=0.17.0
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) rel='x86_64-unknown-linux-gnu' ;; \
    arm64) rel='aarch64-unknown-linux-gnu' ;; \
    i386)  rel='i686-unknown-linux-gnu' ;; \
    *)     echo "delta: unsupported arch: $arch; skipping"; exit 0 ;; \
  esac; \
  url="https://github.com/dandavison/delta/releases/download/${DELTA_VER}/delta-${DELTA_VER}-${rel}.tar.gz"; \
  echo "Fetching $url"; \
  curl -fsSL "$url" -o /tmp/delta.tgz; \
  tar -xzf /tmp/delta.tgz -C /tmp; \
  install -m 0755 /tmp/delta-${DELTA_VER}-${rel}/delta /usr/local/bin/delta; \
  rm -rf /tmp/delta*; \
  /usr/local/bin/delta --version || true

# ---------- Bun: install to a fixed, root-owned path ----------
# (So we never depend on $HOME/.bun and can hard-code it safely)
ARG BUN_VERSION=1.2.19
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) bun_arch='x64' ;; \
    arm64) bun_arch='aarch64' ;; \
    *) echo "Unsupported arch for Bun: $arch"; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip" -o /tmp/bun.zip; \
  mkdir -p /tmp/bun; \
  unzip /tmp/bun.zip -d /tmp/bun >/dev/null; \
  # zip layout: bun-linux-<arch>/bun
  install -m 0755 /tmp/bun/bun-linux-${bun_arch}/bun /usr/local/bin/bun; \
  rm -rf /tmp/bun /tmp/bun.zip; \
  /usr/local/bin/bun --version

# Hard-coded paths we’ll reference from the app
ENV ORG_BUN_BIN=/usr/local/bin/bun
ENV ORG_TMUX_BIN=/usr/bin/tmux
ENV ORG_DEFAULT_CWD=/work

# --- Portable apply_patch helper (no heredocs) ---
RUN set -eux; \
  printf '%s\n' \
'#!/usr/bin/env bash' \
'set -euo pipefail' \
'# If project provides its own helper, defer to it:' \
'if [ -x /work/.org/bin/apply_patch ]; then' \
'  exec /work/.org/bin/apply_patch "$@"' \
'fi' \
'' \
'# Otherwise accept unified diff from stdin or -f <file> and apply safely.' \
'WORK_ROOT="${ORG_WORK:-/work}"' \
'PATCH_FILE=""' \
'while [ $# -gt 0 ]; do' \
'  case "$1" in' \
'    -f|--file) PATCH_FILE="$2"; shift 2;;' \
'    -) PATCH_FILE="-"; shift;;' \
'    *) echo "apply_patch: unknown arg: $1" >&2; exit 2;;' \
'  esac' \
'done' \
'' \
'tmp_patch="/tmp/ap.$$.patch"' \
'if [ -z "$PATCH_FILE" ] || [ "$PATCH_FILE" = "-" ]; then' \
'  cat > "$tmp_patch"' \
'else' \
'  cp "$PATCH_FILE" "$tmp_patch"' \
'fi' \
'' \
'# Extract candidate paths (from diff --git ... b/...) and police them.' \
'mapfile -t paths < <(awk '\''/^diff --git a\\//{print $4}'\'' "$tmp_patch" | sed -E '\''s#^b/##'\'')' \
'if [ "${#paths[@]}" -eq 0 ]; then' \
'  echo "apply_patch: no file paths detected (expects unified diff)." >&2' \
'  exit 1' \
'fi' \
"deny_regex='^(\\.git/|\\.org/|/|\\.{2}(/|$)|.*\\x00.*)'" \
'viol=""' \
'for p in "${paths[@]}"; do' \
'  p="${p#./}"' \
'  if [[ "$p" =~ $deny_regex ]]; then' \
'    viol+="$p\n"' \
'  fi' \
'done' \
'if [ -n "$viol" ]; then' \
'  printf '\''apply_patch: path policy violation(s):\n%s'\'' "$viol" >&2' \
'  exit 3' \
'fi' \
'' \
'# Dry-run first; then apply.' \
'git -C "$WORK_ROOT" apply --index --whitespace=nowarn --check "$tmp_patch"' \
'git -C "$WORK_ROOT" apply --index --whitespace=nowarn "$tmp_patch"' \
'echo "apply_patch: OK"' \
> /usr/local/bin/apply_patch \
 && chmod +x /usr/local/bin/apply_patch

# Optional: patch viewer command (for tmux popup or scripts)
ENV ORG_PATCH_POPUP_CMD='bash -lc "if test -f .org/last-session.patch; then (command -v delta >/dev/null && delta -s --paging=never .org/last-session.patch || (echo; echo \"(delta not found; showing raw patch)\"; echo; cat .org/last-session.patch)); else echo \"No session patch found.\"; fi; echo; read -p \"Enter to close...\" _"'

# --- Robust networking defaults for UI processes (console + tmux) ---

# Stable alias to the VM host from inside a Linux container. Works with podman & docker.
# (We don't strictly need to set this, but it's nice to have a canonical place.)
ENV ORG_HOST_ALIAS=host.containers.internal

# Default OpenAI-compatible base if none is provided. LM Studio often lives at 11434.
# Your code that builds the client should prefer ORG_OPENAI_BASE if present.
ENV ORG_OPENAI_BASE_DEFAULT=http://host.containers.internal:11434/v1

# Make proxy bypass bulletproof for local endpoints and the VM host alias.
# If user already sets NO_PROXY, keep it; just append what we need.
ENV NO_PROXY=localhost,127.0.0.1,::1,host.containers.internal,192.168.56.1

# (Optional) if you want PATH to always contain bun for clean tmux shells:
ENV PATH="/root/.bun/bin:/home/ollama/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

COPY container/entrypoint.sh /usr/local/bin/org-entrypoint
RUN chmod +x /usr/local/bin/org-entrypoint
# ENTRYPOINT ["/usr/local/bin/org-entrypoint"]  # (optional; you can also call it explicitly)

