#!/usr/bin/env bash
# install.sh — one-time installer inside the VM
# - ALWAYS pre-build the Podman sandbox image (no prompts)
# - Symlink /usr/local/bin/org -> <repo>/org
# - Install host launchers in /usr/local/libexec/org/launch-* (includes PATCH REVIEW)
# - Portable networking: use host.containers.internal + slirp host-loopback
# - Logs to $HOME/.org/logs/install-*.log
# - No git ops; repo is bind-mounted from host

set -Eeuo pipefail

# -------- logging --------
LOG_DIR="$HOME/.org/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/install-$(date +%Y%m%d-%H%M%S).log"
export PS4='+ [$(date -Is)] '
exec > >(tee -a "$LOG_FILE") 2>&1

log()  { printf "\033[1;36m[org-install]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[org-install][warn]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[org-install][error]\033[0m %s\n" "$*" >&2; }
die()  { err "$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

log "=== INSTALL START $(date -Is) ==="

# -------- args --------
REPO_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C) REPO_DIR="$2"; shift 2 ;;
    -h|--help|help)
      cat <<'USAGE'
Usage: bash install.sh [-C <repo_dir>]
  -C <dir>   Run installer as if invoked from <dir> (must be a git repo).
USAGE
      exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${REPO_DIR}" ]] && cd "$REPO_DIR"

# -------- preflight --------
need bash
if command -v apt-get >/dev/null 2>&1; then PKG=apt-get; else die "Requires apt-get (Ubuntu/Debian)."; fi
[[ -d .git ]] || die "Not a git repository: $(pwd)."

# Ensure ufw exists (used for temporary egress)
if ! command -v ufw >/dev/null 2>&1; then
  log "Installing ufw ..."
  sudo ${PKG} update -y
  sudo ${PKG} install -y ufw
fi

# Optional: bun deps (non-fatal)
if command -v bun >/dev/null 2>&1; then
  log "bun install (optional)"
  ( set -Eeuo pipefail; bun install || true )
else
  warn "bun not found; skipping 'bun install' (this is fine)"
fi

# -------- ensure podman (fallback) --------
ensure_podman() {
  if command -v podman >/dev/null 2>&1; then return; fi
  warn "podman not found — attempting installation now (fallback)"
  sudo ${PKG} update -y
  if ! apt-cache policy podman | grep -q Candidate; then
    sudo ${PKG} install -y software-properties-common ca-certificates curl gnupg
    sudo add-apt-repository -y universe
    sudo ${PKG} update -y
  fi
  sudo ${PKG} install -y podman uidmap slirp4netns fuse-overlayfs iptables containernetworking-plugins
}
ensure_podman

# -------- /usr/local/bin/org -> repo root 'org' --------
if [[ ! -L /usr/local/bin/org || "$(readlink -f /usr/local/bin/org || true)" != "$(pwd)/org" ]]; then
  log "Symlinking /usr/local/bin/org -> $(pwd)/org"
  sudo ln -sfn "$(pwd)/org" /usr/local/bin/org
fi

# -------- install host launchers (container + PATCH REVIEW) --------
install_libexec_launcher() {
  local mode="$1"                   # console|tmux|rich
  local target="/usr/local/libexec/org/launch-$mode"
  local dir; dir="$(dirname "$target")"
  sudo install -d -m 0755 "$dir"
  sudo tee "$target" >/dev/null <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
MODE="__MODE__"

# Project root on host filesystem (bind-mounted)
GIT_ROOT=$(git -C "${ORG_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel 2>/dev/null || echo "${ORG_PROJECT_DIR:-$PWD}")
RUNS_DIR="$GIT_ROOT/.org/runs"
mkdir -p "$GIT_ROOT/.org"

# Network args:
# - slirp4netns host-loopback so 'host.containers.internal' resolves to host
NETWORK_ARGS=( --network "slirp4netns:allow_host_loopback=true" )

# Portable env for in-container discovery
ENV_ARGS=(
  -e ORG_BACKEND=podman
  -e SANDBOX_BACKEND=podman
  -e ORG_HOST_ALIAS=host.containers.internal
  -e NO_PROXY="localhost,127.0.0.1,::1,host.containers.internal"
)

# 1) Run the containerized UI
podman run --rm -it \
  "${NETWORK_ARGS[@]}" \
  -v "$GIT_ROOT:/project:ro" \
  -v "$GIT_ROOT/.org:/work/.org:rw" \
  "${ENV_ARGS[@]}" \
  org-sandbox:latest "/application/scripts/org-launch-$MODE.logic.sh" "$@"
code=$?

# 2) Host-side PATCH REVIEW (newest session.patch)
patch=""
if [ -d "$RUNS_DIR" ]; then
  latest_run=$(ls -1dt "$RUNS_DIR"/* 2>/dev/null | head -1 || true)
  if [ -n "$latest_run" ] && [ -f "$latest_run/session.patch" ]; then
    patch="$latest_run/session.patch"
  fi
fi
if [ -n "$patch" ]; then
  if [ -x "$GIT_ROOT/scripts/host-patch-review.sh" ]; then
    "$GIT_ROOT/scripts/host-patch-review.sh" "$patch" "$GIT_ROOT" || true
  else
    echo "[org-launch-$MODE] host-patch-review.sh not found; attempting 'git apply --index'"
    git -C "$GIT_ROOT" apply --index "$patch" || {
      echo "[org-launch-$MODE] git apply failed; leaving patch at $patch"
    }
  fi
else
  echo "[org-launch-$MODE] No session.patch found; nothing to review/apply."
fi

exit "$code"
EOF
  # replace placeholder with mode
  sudo sed -i "s/__MODE__/$mode/g" "$target"
  sudo chmod +x "$target"
  log "Installed host launcher: $target"
}
install_libexec_launcher console
install_libexec_launcher tmux
install_libexec_launcher rich

# -------- firewall helpers (for the image build only) --------
UFW_COMMENT="org-install-temporary-build-egress"
allow_temp_egress() {
  if ! sudo ufw status >/dev/null 2>&1; then
    warn "ufw not active; skipping temporary egress rules"
    return
  fi
  log "Temporarily allowing egress: 53/udp, 80/tcp, 443/tcp"
  sudo ufw allow out proto udp to any port 53  comment "$UFW_COMMENT" || true
  sudo ufw allow out proto tcp to any port 80  comment "$UFW_COMMENT" || true
  sudo ufw allow out proto tcp to any port 443 comment "$UFW_COMMENT" || true
}
revoke_temp_egress() {
  if ! sudo ufw status >/dev/null 2>&1; then return; fi
  log "Revoking temporary egress rules"
  mapfile -t RULE_LINES < <(sudo ufw status numbered | sed -n 's/^\[\([0-9]\+\)\]\s\+\(.*\)$/\1 \2/p' | grep "$UFW_COMMENT" || true)
  for (( idx=${#RULE_LINES[@]}-1 ; idx>=0 ; idx-- )); do
    num="$(awk '{print $1}' <<<"${RULE_LINES[$idx]}")"
    yes | sudo ufw delete "$num" >/dev/null 2>&1 || true
  done
}
trap 'revoke_temp_egress || true' EXIT

# -------- build image (always) --------
build_podman_image() {
  local dockerfile=""
  if   [[ -f Dockerfile.sandbox ]]; then dockerfile="Dockerfile.sandbox"
  elif [[ -f Containerfile      ]]; then dockerfile="Containerfile"
  else
    warn "No Dockerfile.sandbox or Containerfile found; skipping image build"
    return 0
  fi
  allow_temp_egress
  log "[org] building image with podman (this can take a while)..."
  podman build -t org-sandbox:latest -f "$dockerfile" .
  log "Image built: org-sandbox:latest"
}
build_podman_image

log "=== INSTALL END $(date -Is) ==="
log "Run 'org --ui console' (or tmux/rich) anywhere in the repo."
