# Containerfile
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive

# Base tools (no git-delta here)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git rsync jq file \
    build-essential pkg-config cmake clang llvm lldb \
    python3 python3-pip python3-venv \
    nodejs npm \
    unzip zip tar xz-utils \
    # --- additions for a good TTY UX ---
    tmux ncurses-term less locales \
    # vim with terminal features (includes `vimdiff`)
    vim-nox \
 && rm -rf /var/lib/apt/lists/*

# Locale for better readline/Unicode behavior
RUN sed -i 's/# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Safe default TERM inside the container; outer terminal can be anything.
ENV TERM=xterm-256color

# ---- Install `delta` (git-delta) from GitHub release for portability ----
ARG DELTA_VER=0.17.0
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64)  rel="x86_64-unknown-linux-gnu" ;; \
    arm64)  rel="aarch64-unknown-linux-gnu" ;; \
    armhf)  rel="arm-unknown-linux-gnueabihf" ;; \
    i386)   rel="i686-unknown-linux-gnu" ;; \
    *)      echo "delta: unsupported arch: $arch; skipping"; exit 0 ;; \
  esac; \
  url="https://github.com/dandavison/delta/releases/download/${DELTA_VER}/delta-${DELTA_VER}-${rel}.tar.gz"; \
  echo "Fetching $url"; \
  curl -fsSL "$url" -o /tmp/delta.tgz; \
  tar -xzf /tmp/delta.tgz -C /tmp; \
  install -m 0755 "/tmp/delta-${DELTA_VER}-${rel}/delta" /usr/local/bin/delta; \
  rm -rf /tmp/delta*; \
  /usr/local/bin/delta --version

# ---- install apply_patch helper safely using Dockerfile heredoc ----
RUN set -eux; \
  cat >/usr/local/bin/apply_patch <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# Hardened apply_patch fallback.
# Priority: If a project-provided /work/.org/bin/apply_patch exists, defer to it.
if [ -x /work/.org/bin/apply_patch ]; then
  exec /work/.org/bin/apply_patch "$@"
fi

# Otherwise accept a unified diff from stdin or -f <file> and apply it safely.
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

# Extract candidate paths and reject anything suspicious before applying.
# We look for paths after `b/` in `diff --git a/... b/...` lines.
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

# Dry-run first; then apply.
git -C "$WORK_ROOT" apply --index --whitespace=nowarn --check "$tmp_patch"
git -C "$WORK_ROOT" apply --index --whitespace=nowarn "$tmp_patch"
echo "apply_patch: OK"
EOF
RUN chmod +x /usr/local/bin/apply_patch

# Optional: helper for viewing the last patch in a tmux popup
ENV ORG_PATCH_POPUP_CMD='bash -lc "if test -f .org/last-session.patch; then (command -v delta >/dev/null && delta -s --paging=never .org/last-session.patch || (echo; echo \"(delta not found; showing raw patch)\"; echo; cat .org/last-session.patch)); else echo \"No session patch found.\"; fi; echo; read -p \"Enter to close...\" _"'
