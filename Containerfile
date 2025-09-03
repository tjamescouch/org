# syntax=docker/dockerfile:1
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
  curl -fsSL "$url" -o /tmp/delta.tgz; \
  tar -xzf /tmp/delta.tgz -C /tmp; \
  install -m 0755 /tmp/delta-${DELTA_VER}-${rel}/delta /usr/local/bin/delta; \
  rm -rf /tmp/delta*; \
  /usr/local/bin/delta --version || true

# ---------- Bun: install to a fixed, root-owned path ----------
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
  unzip -q /tmp/bun.zip -d /tmp/bun; \
  install -m 0755 /tmp/bun/bun-linux-${bun_arch}/bun /usr/local/bin/bun; \
  rm -rf /tmp/bun /tmp/bun.zip; \
  /usr/local/bin/bun --version

# Hard-coded paths we’ll reference from the app
ENV ORG_BUN_BIN=/usr/local/bin/bun \
    ORG_TMUX_BIN=/usr/bin/tmux \
    ORG_DEFAULT_CWD=/work

# Optional: patch viewer command (for tmux popup or scripts)
ENV ORG_PATCH_POPUP_CMD='bash -lc "if test -f .org/last-session.patch; then (command -v delta >/dev/null && delta -s --paging=never .org/last-session.patch || (echo; echo \"(delta not found; showing raw patch)\"; echo; cat .org/last-session.patch)); else echo \"No session patch found.\"; fi; echo; read -p \"Enter to close...\" _"'

# --- Robust networking defaults for UI processes (console + tmux) ---
ENV ORG_HOST_ALIAS=host.containers.internal
ENV ORG_OPENAI_BASE_DEFAULT=http://host.containers.internal:11434/v1
ENV NO_PROXY=localhost,127.0.0.1,::1,host.containers.internal,192.168.56.1
ENV PATH="/root/.bun/bin:/home/ollama/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Bring the current repo in (optional, but handy for reusing bits)
WORKDIR /opt/org
COPY . /opt/org

# -------- container-side helpers: apply_patch + org (tmux/console) --------

# Portable apply_patch (no heredocs at runtime)
RUN set -eux; cat >/usr/local/bin/apply_patch <<'EOF_APPLY' \
#!/usr/bin/env bash
set -euo pipefail
WORK_ROOT="${ORG_WORK:-/work}"
PATCH_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -f|--file) PATCH_FILE="$2"; shift 2;;
    -) PATCH_FILE="-"; shift;;
    *) echo "apply_patch: unknown arg: $1" >&2; exit 2;;
  esac
done
tmp_patch="/tmp/ap.$$.patch"
if [ -z "$PATCH_FILE" ] || [ "$PATCH_FILE" = "-" ]; then
  cat > "$tmp_patch"
else
  cp "$PATCH_FILE" "$tmp_patch"
fi
mapfile -t paths < <(awk '/^diff --git a\//{print $4}' "$tmp_patch" | sed -E 's#^b/##')
if [ "${#paths[@]}" -eq 0 ]; then
  echo "apply_patch: no file paths detected (expects unified diff)." >&2
  exit 1
fi
deny_regex='^(\.git/|\.org/|/|\.{2}(/|$)|.*\x00.*)'
viol=""
for p in "${paths[@]}"; do
  p="${p#./}"
  if [[ "$p" =~ $deny_regex ]]; then
    viol+="$p\n"
  fi
done
if [ -n "$viol" ]; then
  printf 'apply_patch: path policy violation(s):\n%s' "$viol" >&2
  exit 3
fi
git -C "$WORK_ROOT" apply --index --whitespace=nowarn --check "$tmp_patch"
git -C "$WORK_ROOT" apply --index --whitespace=nowarn "$tmp_patch"
echo "apply_patch: OK"
EOF_APPLY
RUN chmod +x /usr/local/bin/apply_patch

# Container-local 'org' that can run the UI and tmux without host scripts
RUN set -eux; cat >/usr/local/bin/org <<'EOF_ORG' \
#!/usr/bin/env bash
set -Eeuo pipefail

CMD="${1:-}"; shift || true

write_tmux_conf() {
  mkdir -p /work/.org /work/.org/logs /work/.org/logs/tmux-logs
  cat >/work/.org/tmux.conf <<'EOF_TMUX'
set -s exit-empty off
set -g default-terminal "tmux-256color"
set -as terminal-overrides ",xterm-256color:Tc,tmux-256color:Tc"
set -g focus-events on
set -s quiet on
EOF_TMUX
}

write_tmux_inner() {
  cat >/work/.org/tmux-inner.sh <<'EOF_INNER'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 0002
exec </dev/tty >/dev/tty 2>&1
export TERM=xterm-256color
export LANG=en_US.UTF-8

LOG_DIR="/work/.org/logs"
mkdir -p "$LOG_DIR" "$LOG_DIR/tmux-logs"
# Keep a real TTY with util-linux 'script' if available; else exec bun directly.
if command -v script >/dev/null 2>&1; then
  exec script -qfe -c '/usr/local/bin/bun /work/src/app.ts --ui console' "$LOG_DIR/tmux-typescript.log"
else
  exec /usr/local/bin/bun /work/src/app.ts --ui console
fi
EOF_INNER
  chmod +x /work/.org/tmux-inner.sh
}

case "${CMD}" in
  console)
    exec /usr/local/bin/bun /work/src/app.ts --ui console "$@"
    ;;
  tmux)
    write_tmux_conf
    write_tmux_inner
    # -L "org" uses a private tmux server socket for the session
    exec /usr/bin/tmux -vv -L org -f /work/.org/tmux.conf new-session -A -s org /work/.org/tmux-inner.sh
    ;;
  apply_patch)
    exec /usr/local/bin/apply_patch "$@"
    ;;
  *)
    echo "Usage: org {console|tmux|apply_patch} [args...]" >&2
    exit 64
    ;;
esac
EOF_ORG
RUN chmod +x /usr/local/bin/org

# Default working directory for bind mounts (host project maps here)
WORKDIR /work
