#!/usr/bin/env bash
# org/launcher/tmux.sh
# Launch org UI inside tmux with robust env propagation and sane defaults.
# This script is meant to run **inside the container**.
set -Eeuo pipefail
umask 0002

# -----------------------------
# Layout & defaults
# -----------------------------
WORK="${ORG_APPDIR:-/work}"
LOGDIR="$WORK/.org/logs"
TMUX_LOGDIR="$LOGDIR/tmux-logs"
INNER="$WORK/.org/tmux-inner.sh"

mkdir -p "$TMUX_LOGDIR" "$WORK/.org"
export TMUX_TMPDIR="$TMUX_LOGDIR"

# Default entry for the inner script (overridable)
ENTRY="${ORG_TMUX_ENTRY:-bun /work/src/app.ts --ui console}"

# PATH so bun works even with --noprofile/--norc shells
export PATH="/home/ollama/.bun/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# Basic terminal/locale
export TERM="${TERM:-xterm-256color}"
export LANG="${LANG:-en_US.UTF-8}"

# Optional stable alias to host (see Containerfile step #1)
# If you didn't add it, this still works fine—it's only a default target in the inner script.
: "${ORG_HOST_ALIAS:=host.containers.internal}"

# Harden NO_PROXY so local endpoints never go through proxies.
_append_np="localhost,127.0.0.1,::1,host.containers.internal,192.168.56.1"
if [ -n "${NO_PROXY:-}" ]; then
  case ",$NO_PROXY," in
    *,host.containers.internal,* ) : ;;
    *) export NO_PROXY="$NO_PROXY,$_append_np" ;;
  esac
else
  export NO_PROXY="$_append_np"
fi

# -----------------------------
# Synthesize ORG_OPENAI_BASE if absent
# -----------------------------
# We tolerate several env spellings and compute a good default.
if [ -z "${ORG_OPENAI_BASE:-}" ]; then
  if [ -n "${OPENAI_BASE_URL:-}" ]; then
    export ORG_OPENAI_BASE="${OPENAI_BASE_URL%/}"
  elif [ -n "${LMSTUDIO_URL:-}" ]; then
    export ORG_OPENAI_BASE="${LMSTUDIO_URL%/}/v1"
  elif [ -n "${ORG_OPENAI_BASE_DEFAULT:-}" ]; then
    export ORG_OPENAI_BASE="${ORG_OPENAI_BASE_DEFAULT%/}"
  else
    export ORG_OPENAI_BASE="http://${ORG_HOST_ALIAS}:11434/v1"
  fi
fi

# -----------------------------
# Write/refresh the inner script
# -----------------------------
cat > "$INNER" <<'INNERSH'
#!/usr/bin/env bash
# org/launcher/tmux-inner.sh (generated)
set -Eeuo pipefail
umask 0002

# Bun/CLI availability even with clean shells
export PATH="/home/ollama/.bun/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export TERM="${TERM:-xterm-256color}"
export LANG="${LANG:-en_US.UTF-8}"

# Keep proxy bypass sane in every pane/window
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1,host.containers.internal,192.168.56.1}"

# Compute ORG_OPENAI_BASE if still unset (inside tmux panes)
if [ -z "${ORG_OPENAI_BASE:-}" ]; then
  if [ -n "${OPENAI_BASE_URL:-}" ]; then
    ORG_OPENAI_BASE="${OPENAI_BASE_URL%/}"
  elif [ -n "${LMSTUDIO_URL:-}" ]; then
    ORG_OPENAI_BASE="${LMSTUDIO_URL%/}/v1"
  elif [ -n "${ORG_OPENAI_BASE_DEFAULT:-}" ]; then
    ORG_OPENAI_BASE="${ORG_OPENAI_BASE_DEFAULT%/}"
  else
    ORG_OPENAI_BASE="http://host.containers.internal:11434/v1"
  fi
  export ORG_OPENAI_BASE
fi

# Small trace to stderr so you can confirm inside tmux once
echo "[tmux] ORG_OPENAI_BASE=$ORG_OPENAI_BASE  NO_PROXY=$NO_PROXY  PATH=$PATH" >&2

# The actual UI entrypoint is injected by tmux.sh with env ORG_TMUX_ENTRY
exec bash -lc "$ENTRY"
INNERSH
chmod +x "$INNER"

# -----------------------------
# Pre-load env into tmux server
# -----------------------------
_keep_vars=(
  OPENAI_API_KEY OPENAI_API_BASE OPENAI_BASE_URL ORG_OPENAI_BASE ORG_OPENAI_BASE_DEFAULT
  LMSTUDIO_URL OLLAMA_HOST
  HTTP_PROXY HTTPS_PROXY NO_PROXY
  PATH LANG TERM
)

_tmux_env_cmds=()
for k in "${_keep_vars[@]}"; do
  if [ -n "${!k:-}" ]; then
    _tmux_env_cmds+=( "set-environment" "-g" "$k" "${!k}" ";" )
  fi
done

# -----------------------------
# Start/attach the session
# -----------------------------
# We use -L org to isolate this UI's server from any user tmux server.
tmux -L org start-server \; \
  set-option -g default-terminal "screen-256color" \; \
  set-option -g update-environment "DISPLAY SSH_.* TERM PATH LANG NO_PROXY HTTP_PROXY HTTPS_PROXY OPENAI_API_KEY OPENAI_BASE_URL ORG_OPENAI_BASE LMSTUDIO_URL OLLAMA_HOST" \; \
  "${_tmux_env_cmds[@]}" \
  new-session -A -s org "bash --noprofile --norc '$INNER'"
