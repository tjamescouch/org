#!/usr/bin/env bash
# install.sh — one-time installer for org inside the VM
# - Safe-by-default firewall; temporary egress for build (53/udp, 80/tcp, 443/tcp), then restore
# - Optionally pre-build the sandbox image (only when backend=podman, and with user confirmation)
# - Verifies working directory (or -C <dir>) is a git repo
# - Conservative: minimal changes, no distro-specific branching beyond apt and ufw usage

set -Eeuo pipefail

# ----------------------------- util -----------------------------
log()  { printf "\033[1;36m[org-install]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[org-install][warn]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[org-install][error]\033[0m %s\n" "$*" >&2; }

die() { err "$*"; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

# ----------------------------- args -----------------------------
REPO_DIR=""
BUILD_IMAGE=${BUILD_IMAGE:-"no"}   # default: don't force build; enable with --build-image or env
# Lima host-loopback (guest -> host)
HOST_LO_IP="${ORG_HOST_LO_IP:-192.168.5.2}"
HOST_LLM_PORT="${ORG_HOST_LLM_PORT:-11434}"
ORG_LLM_BASE_URL="${ORG_LLM_BASE_URL:-http://${HOST_LO_IP}:${HOST_LLM_PORT}}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C)
      REPO_DIR="$2"; shift 2 ;;
    --build-image)
      BUILD_IMAGE="yes"; shift ;;
    -h|--help|help)
      cat <<'USAGE'
Usage: bash install.sh [-C <repo_dir>] [--build-image]
  -C <dir>        Run installer as if invoked from <dir> (must be a git repo).
  --build-image   Pre-build the Podman sandbox image during install.
Env:
  SANDBOX_BACKEND=podman|docker|local|mock  (default: detect)
  ORG_ENGINE=podman|docker|local|mock       (alias, for historical configs)
USAGE
      exit 0 ;;
    *)
      die "Unknown argument: $1" ;;
  esac
done

if [[ -n "${REPO_DIR}" ]]; then
  cd "$REPO_DIR"
fi

# ---------------------- preflight / platform --------------------
need git
need bash
if command -v apt-get >/dev/null 2>&1; then
  PKG=apt-get
else
  die "This installer assumes apt-get (Ubuntu/Debian)."
fi

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

# ---------------------- backend detection -----------------------
detect_backend() {
  local v=""
  v="${SANDBOX_BACKEND:-${ORG_ENGINE:-}}"
  v="${v,,}" # to lower
  case "$v" in
    podman|docker|local|mock) echo "$v"; return 0 ;;
    none|host|native) echo "local"; return 0 ;;
  esac
  # Fallbacks based on what exists
  if command -v podman >/dev/null 2>&1; then echo "podman"; return 0; fi
  if command -v docker  >/dev/null 2>&1; then echo "docker"; return 0; fi
  echo "local"
}
BACKEND="$(detect_backend)"
log "Detected sandbox backend: ${BACKEND}"

# --------------------- firewall helpers -------------------------
# Our policy is: locked-down by default; open narrowly for build; then close.
# Some environments already have ufw enabled/disabled. We won’t change the enable state here.
# We add rules with a unique comment so we can remove them after.

UFW_COMMENT="org-install-temporary-build-egress"

allow_temp_egress() {
  if ! sudo ufw status >/dev/null 2>&1; then
    warn "ufw not active; skipping temporary egress rules"
    return
  fi
  log "Temporarily allowing egress: DNS(53/udp), HTTP(80/tcp), HTTPS(443/tcp) for container/image builds"
  # Using comments permits clean deletion
  sudo ufw allow out proto udp to any port 53  comment "$UFW_COMMENT" || true
  sudo ufw allow out proto tcp to any port 80  comment "$UFW_COMMENT" || true
  sudo ufw allow out proto tcp to any port 443 comment "$UFW_COMMENT" || true
  # Rootless podman slirp4netns sometimes uses high ephemeral ports; usually not needed outbound,
  # but if your policy blocks ESTABLISHED,RELATED you might need a broader allowance.
}

revoke_temp_egress() {
  if ! sudo ufw status >/dev/null 2>&1; then
    return
  fi
  log "Revoking temporary egress rules"
  # Delete all rules with our comment
  # `ufw` doesn't have "delete by comment", so we parse and delete matching lines.
  mapfile -t RULE_LINES < <(sudo ufw status numbered | sed -n 's/^\[\([0-9]\+\)\]\s\+\(.*\)$/\1 \2/p' | grep "$UFW_COMMENT" || true)
  # Delete in reverse order so indices remain valid
  for (( idx=${#RULE_LINES[@]}-1 ; idx>=0 ; idx-- )); do
    num="$(awk '{print $1}' <<<"${RULE_LINES[$idx]}")"
    yes | sudo ufw delete "$num" >/dev/null 2>&1 || true
  done
}

trap 'revoke_temp_egress || true' EXIT

# --------------------- build image (podman) ---------------------
maybe_build_image() {
  local dockerfile=""
  if [[ -f Dockerfile.sandbox ]]; then
    dockerfile="Dockerfile.sandbox"
  elif [[ -f Containerfile ]]; then
    dockerfile="Containerfile"
  else
    warn "No Dockerfile.sandbox or Containerfile found; skipping image build"
    return 0
  fi

  case "$BACKEND" in
    podman)
      if [[ "${BUILD_IMAGE}" != "yes" ]]; then
        log "Sandbox backend is podman; image will be built lazily at first run. (Use --build-image to prewarm now.)"
        return 0
      fi
      ;;

    docker)
      warn "Backend is docker; leaving image build to first run (or build manually)."
      return 0
      ;;

    *)
      log "Backend is ${BACKEND}; no container image to build."
      return 0
      ;;
  esac

  # Confirm with the user
  printf "\nAbout to build the sandbox image with Podman using %s\n" "$dockerfile"
  read -r -p "Proceed now? [y/N] " ans
  if [[ ! "$ans" =~ ^[Yy]([Ee][Ss])?$ ]]; then
    warn "User declined image build; it will occur on first 'org' run."
    return 0
  fi

  need podman

  allow_temp_egress
  log "[org] building image with podman (this can take a while)..."
  podman build -t org-sandbox:latest -f "$dockerfile" .
  log "Image built: org-sandbox:latest"
}

# ------------------------- main --------------------------------
maybe_build_image

log "Install complete."
log "Tip: Run 'org --ui console' (or tmux/rich) in this repo to start."
