# Containerfile (excerpt)
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive

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
    # nicer patch/diff viewer (binary `delta`)
    git-delta \
 && rm -rf /var/lib/apt/lists/*

# Locale for better readline/Unicode behavior (optional but nice)
RUN sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Safe default TERM inside the container; outer terminal can be anything.
ENV TERM=xterm-256color

# --- OPTIONAL: bake an apply_patch fallback directly into the image ---
# If you prefer not to add a separate file in build context, inline it:
RUN install -d /usr/local/bin && bash -lc 'cat > /usr/local/bin/apply_patch << "EOF"\n\
#!/usr/bin/env bash\n\
set -euo pipefail\n\
# Hardened apply_patch fallback.\n\
# Priority: If a project-provided /work/.org/bin/apply_patch exists, defer to it.\n\
if [ -x /work/.org/bin/apply_patch ]; then\n\
  exec /work/.org/bin/apply_patch \"$@\"\n\
fi\n\
# Otherwise accept a unified diff from stdin or -f <file> and apply it safely.\n\
WORK_ROOT=\"${ORG_WORK:-/work}\"\n\
PATCH_FILE=\"\"\n\
while [ $# -gt 0 ]; do\n\
  case \"$1\" in\n\
    -f|--file) PATCH_FILE=\"$2\"; shift 2;;\n\
    -) PATCH_FILE=\"-\"; shift;;\n\
    *) echo \"apply_patch: unknown arg: $1\" >&2; exit 2;;\n\
  esac\n\
done\n\
tmp_patch=\"/tmp/ap.$$.patch\"\n\
if [ -z \"$PATCH_FILE\" ] || [ \"$PATCH_FILE\" = \"-\" ]; then\n\
  cat > \"$tmp_patch\"\n\
else\n\
  cp \"$PATCH_FILE\" \"$tmp_patch\"\n\
fi\n\
# Extract candidate paths and reject anything suspicious before applying.\n\
# We look for paths after `b/` in `diff --git a/... b/...` lines.\n\
mapfile -t paths < <(awk \"/^diff --git a\\//{print \\$4}\" \"$tmp_patch\" | sed -E 's#^b/##')\n\
if [ \"${#paths[@]}\" -eq 0 ]; then\n\
  echo \"apply_patch: no file paths detected (expects unified diff).\" >&2; exit 1\n\
fi\n\
deny_regex=\"^(\\.git/|\\.org/|/|\\.\\.|.*\\\\x00.*)\"\n\
viol=\"\"\n\
for p in \"${paths[@]}\"; do\n\
  # normalize a bit\n\
  p=\"${p#./}\"\n\
  if [[ \"$p\" =~ $deny_regex ]]; then\n\
    viol+=\"$p\\n\"\n\
  fi\n\
done\n\
if [ -n \"$viol\" ]; then\n\
  echo -e \"apply_patch: path policy violation(s):\\n$viol\" >&2\n\
  exit 3\n\
fi\n\
# Dry-run first; then apply.\n\
git -C \"$WORK_ROOT\" apply --index --whitespace=nowarn --check \"$tmp_patch\"\n\
git -C \"$WORK_ROOT\" apply --index --whitespace=nowarn \"$tmp_patch\"\n\
echo \"apply_patch: OK\"\n\
EOF\n\
chmod +x /usr/local/bin/apply_patch'

# Optional: make it easy to view the last patch in a popup (tmux binding uses this)
ENV ORG_PATCH_POPUP_CMD='bash -lc "if test -f .org/last-session.patch; then (command -v delta >/dev/null && delta -s --paging=never .org/last-session.patch || (echo; echo \"(delta not found; showing raw patch)\"; echo; cat .org/last-session.patch)); else echo \"No session patch found.\"; fi; echo; read -p \"Enter to close...\" _"'
