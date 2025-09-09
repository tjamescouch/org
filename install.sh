#!/usr/bin/env bash
# install.sh — one-time installer for org inside the VM
# - Safe-by-default firewall; temporary egress for build (53/udp, 80/tcp, 443/tcp), then restore
# - ALWAYS pre-build the Podman sandbox image (no prompts)
# - Verifies working directory (or -C <dir>) is a git repo
# - Conservative: minimal changes, Ubuntu/Debian via apt and ufw

set -Eeuo pipefail

# ----------------------------- util -----------------------------
log()  { printf "\033[1;36m[org-install]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[org-install][warn]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[org-install][error]\033[0m %s\n" "$*" >&2; }
die()  { err "$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

# ----------------------------- args -----------------------------
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

# ---------------------- preflight / platform --------------------
need git; need bash
if command -v apt-get >/dev/null 2>&1; then PKG=apt-get
else die "This installer assumes apt-get (Ubuntu/Debian)."; fi

# Verify git repo
[[ -d .git ]] || die "Not a git repository: $(pwd). Use -C <repo> or run from the repo root."

# Ensure ufw exists (Ubuntu VM has it by default in our Lima config)
if ! command -v ufw >/dev/null 2>&1; then
  log "Installing ufw (firewall) ..."
  sudo ${PKG} update -y
  sudo ${PKG} install -y ufw
fi

# Optional: Bun dependencies (skip if bun missing; do not fail install)
if command -v bun >/dev/null 2>&1; then
  log "Installing project dependencies with bun (if any)"
  ( set -Eeuo pipefail; bun install || true )
else
  warn "bun not found; skipping 'bun install' (this is fine)"
fi

# Expose "org" command as a symlink to repo script, if not present
if [[ ! -x /usr/local/bin/org || "$(readlink -f /usr/local/bin/org || true)" != "$(pwd)/scripts/org" ]]; then
  log "Linking /usr/local/bin/org -> $(pwd)/scripts/org"
  sudo install -m 0755 -D "$(pwd)/scripts/org" /usr/local/bin/org
fi

# --------------------- firewall helpers -------------------------
UFW_COMMENT="org-install-temporary-build-egress"

allow_temp_egress() {
  if ! sudo ufw status >/dev/null 2>&1; then
    warn "ufw not active; skipping temporary egress rules"
    return
  fi
  log "Temporarily allowing egress: DNS(53/udp), HTTP(80/tcp), HTTPS(443/tcp) for container/image builds"
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

# --------------------- ALWAYS build image -----------------------
build_podman_image() {
  local dockerfile=""
  if   [[ -f Dockerfile.sandbox ]]; then dockerfile="Dockerfile.sandbox"
  elif [[ -f Containerfile      ]]; then dockerfile="Containerfile"
  else
    warn "No Dockerfile.sandbox or Containerfile found; skipping image build"
    return 0
  fi

  need podman
  allow_temp_egress
  log "[org] building image with podman (this can take a while)..."
  podman build -t org-sandbox:latest -f "$dockerfile" .
  log "Image built: org-sandbox:latest"
}

# ------------------------- main --------------------------------
build_podman_image

log "Install complete."
log "Tip: Run 'org --ui console' (or tmux/rich) in this repo to start."
