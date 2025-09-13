#!/usr/bin/env bash
# org-launcher-tmux
# Single-command tmux launcher for org that preserves a real TTY and logs pane output.
# Usage: org --ui tmux [app-args...]
#
# Behavior:
# - Creates/attaches a tmux session.
# - Runs the app inside a PTY (via `script`) so stdout/stderr are interactive & visible.
# - Pipes the pane to a rotating log file without breaking TTY.
# - Keeps the pane on screen after exit (remain-on-exit) for postmortem.

set -Eeuo pipefail

# ---- Entrypoints & binaries --------------------------------------------------
BUN_BIN="${ORG_BUN_BIN:-/usr/local/bin/bun}"
APP_ENTRY="${ORG_APP_ENTRY:-/application/src/app.ts}"

# ---- Preferred working directory (container: /work; else PWD) ----------------
ORG_WORKDIR_DEFAULT="/work"
ORG_WORKDIR="${ORG_WORKDIR:-${ORG_WORKDIR_DEFAULT}}"
if [[ ! -d "$ORG_WORKDIR" ]]; then
  ORG_WORKDIR="$PWD"
fi

ORG_SCRIPTS_DIR="/application/scripts"
TMUX_CONF="$ORG_SCRIPTS_DIR/tmux.conf"

# State and logs live under .org/
ORG_STATE_DIR="${ORG_STATE_DIR:-$ORG_WORKDIR/.org}"
ORG_LOG_DIR="$ORG_STATE_DIR/logs"
ORG_TMUX_LOG_DIR="$ORG_LOG_DIR/tmux-logs"

# tmux identifiers
ORG_TMUX_SOCKET="${ORG_TMUX_SOCKET:-org}"
ORG_TMUX_SESSION="${ORG_TMUX_SESSION:-org}"
ORG_TMUX_WINDOW="${ORG_TMUX_WINDOW:-0}"
ORG_TMUX_PANE="${ORG_TMUX_PANE:-0}"

# Log files
PANE_LOG="$ORG_LOG_DIR/pane-0.log"
INNER_LOG="$ORG_LOG_DIR/tmux-inner.log"

# Tools
SHELL_BIN="${SHELL:-/bin/bash}"
SCRIPT_BIN="$(command -v script || true)"

# Keep global git config out of /work so it never becomes part of the patch.
if [ "${HOME:-/work}" = "/work" ]; then
  export GIT_CONFIG_GLOBAL="/tmp/org/gitconfig"
  mkdir -p /tmp/org
  : > "$GIT_CONFIG_GLOBAL"  # ensure file exists (idempotent)
fi

# ---- Prep dirs ---------------------------------------------------------------
mkdir -p "$ORG_STATE_DIR" "$ORG_LOG_DIR" "$ORG_TMUX_LOG_DIR"
chmod 700 "$ORG_STATE_DIR" || true

# ---- Arg handling: strip external --ui and force console inside tmux ---------
RAW_ARGS=("$@")
APP_ARGS=()
skip_next=0
for ((i=0; i<${#RAW_ARGS[@]}; i++)); do
  if (( skip_next )); then
    skip_next=0; continue
  fi
  arg="${RAW_ARGS[i]}"
  case "$arg" in
    --) # pass through the rest verbatim
      APP_ARGS+=("${RAW_ARGS[@]:i}")
      break
      ;;
    --ui) # drop --ui <value>
      skip_next=1
      ;;
    --ui=*) # drop --ui=*
      ;;
    *) APP_ARGS+=("$arg") ;;
  esac
done

# Compose the final command *as an argv array*:
CMD=("$BUN_BIN" "$APP_ENTRY" --ui console "${APP_ARGS[@]}")

# Safely-quoted string form for `script -c` / logging (no trailing space)
printf -v ORG_CMD_STR "%q " "${CMD[@]}"
ORG_CMD_STR="${ORG_CMD_STR% }"

# ---- Tiny inner runner to avoid quoting foot-guns ----------------------------
INNER_RUNNER="$ORG_STATE_DIR/tmux-inner.sh"
cat >"$INNER_RUNNER" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

LOG_DIR="${ORG_LOG_DIR:?}"
APP_LOG="${INNER_LOG:?}"
ENTRY_STR="${ORG_CMD_STR:?}"
SHELL_BIN="${SHELL_BIN:-/bin/bash}"
SCRIPT_BIN="${SCRIPT_BIN:-}"

{
  echo "===== org tmux-inner start: $(date -Is) ====="
  echo "[inner] cwd=$(pwd) uid=$(id -u):$(id -g) PATH=$PATH"
  echo "[inner] entry: ${ENTRY_STR}"
} >>"$APP_LOG" 2>&1

# If util-linux `script` is available, use it to preserve a real PTY while logging.
if [[ -n "$SCRIPT_BIN" ]]; then
  exec "$SCRIPT_BIN" -qfe -c "$ENTRY_STR" "$APP_LOG"
fi

# Fallback keeps logs (tee) but lacks PTY semantics.
exec "$SHELL_BIN" -lc "$ENTRY_STR 2>&1 | tee -a \"$APP_LOG\"; exit \${PIPESTATUS[0]}"
EOF
chmod +x "$INNER_RUNNER"

# Export runtime variables for the inner runner
export ORG_LOG_DIR ORG_TMUX_LOG_DIR INNER_LOG ORG_CMD_STR SHELL_BIN SCRIPT_BIN

# ---- tmux bootstrap ----------------------------------------------------------
export TMUX_TMPDIR="${TMUX_TMPDIR:-/tmp}"
tmux -L "$ORG_TMUX_SOCKET" -f "$TMUX_CONF" start-server

# Create session if it doesn't exist yet
if ! tmux -L "$ORG_TMUX_SOCKET" -f "$TMUX_CONF" has-session -t "$ORG_TMUX_SESSION" 2>/dev/null; then
  # Start the session detached running our inner runner (prefer requested workdir)
  tmux -L "$ORG_TMUX_SOCKET" -f "$TMUX_CONF" new-session -s "$ORG_TMUX_SESSION" -n main -c "$ORG_WORKDIR" "exec \"$INNER_RUNNER\""
  # Keep pane visible after exit for debugging
  tmux -L "$ORG_TMUX_SOCKET" -f "$TMUX_CONF" set-option -t "$ORG_TMUX_SESSION" remain-on-exit on

  # Mirror pane output to a timestamped log (does not break TTY)
  tmux -L "$ORG_TMUX_SOCKET" -f "$TMUX_CONF" pipe-pane -t "$ORG_TMUX_SESSION:$ORG_TMUX_WINDOW.$ORG_TMUX_PANE" -o "ts %H:%M:%.S >> \"$PANE_LOG\"" || true
fi

# If a pipe-pane got disabled somehow, ensure it's on (idempotent).
tmux -L "$ORG_TMUX_SOCKET" -f "$TMUX_CONF" pipe-pane -t "$ORG_TMUX_SESSION:$ORG_TMUX_WINDOW.$ORG_TMUX_PANE" -o "ts %H:%M:%.S >> \"$PANE_LOG\"" || true

# ---- Attach ------------------------------------------------------------------
exec tmux -L "$ORG_TMUX_SOCKET" -f "$TMUX_CONF" attach -t "$ORG_TMUX_SESSION"
