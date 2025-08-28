#!/usr/bin/env bash
# Launch the org tmux UI from inside the container.
# Repo file (persistent): org/launcher/tmux.sh
# Runtime artifacts (ephemeral): .org/*
set -Eeuo pipefail

# ----- Resolve directories -----
APPDIR="${ORG_APPDIR:-$PWD}"           # repo root in the container (we mount PWD -> /work)
RUNDIR="$APPDIR/.org"                  # runtime output
LOGDIR="$RUNDIR/logs"
TMUXLOG="$LOGDIR/tmux-logs"
INNER="$RUNDIR/tmux-inner.sh"

mkdir -p "$TMUXLOG"

# ----- Environment for a decent TTY -----
export TMUX_TMPDIR="$TMUXLOG"
export TERM="${TERM:-xterm-256color}"
export LANG="${LANG:-en_US.UTF-8}"

# ----- Find bun (try common locations if not on PATH) -----
if ! command -v bun >/dev/null 2>&1; then
  for c in /usr/local/bin/bun /home/ollama/.bun/bin/bun /root/.bun/bin/bun; do
    if [ -x "$c" ]; then
      export PATH="$(dirname "$c"):$PATH"
      break
    fi
  done
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "[tmux] bun not found in PATH; looked in /usr/local/bin, ~/.bun/bin, and /root/.bun/bin" >&2
  exit 127
fi

# ----- Command to run inside tmux -----
# You may override with:  ORG_TMUX_ENTRY='bun /work/src/app.ts --ui console'
ENTRY="${ORG_TMUX_ENTRY:-"bun $APPDIR/src/app.ts --ui console"}"

# ----- Create a tiny inner script to keep quoting sane -----
cat >"$INNER" <<'EOS'
#!/usr/bin/env bash
set -Eeuo pipefail
: "${TERM:=xterm-256color}"
: "${LANG:=en_US.UTF-8}"

if [[ -z "${ORG_TMUX_ENTRY:-}" ]]; then
  echo "[tmux-inner] ORG_TMUX_ENTRY is empty" >&2
  exit 64
fi

# Run in a login shell so PATH and rc files behave
exec bash -lc "$ORG_TMUX_ENTRY"
EOS
chmod +x "$INNER"

export ORG_TMUX_ENTRY="$ENTRY"

# ----- Fire up tmux (session name: 'org') -----
exec /usr/bin/tmux -vv new-session -A -s org "$INNER"
