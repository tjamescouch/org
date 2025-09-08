#!/usr/bin/env bash
# install.sh — smart, idempotent guest setup for `org`
# - Installs system deps (curl, git, openssh-server, ufw, podman)
# - Hardens firewall (deny IN/OUT; allow SSH IN; allow 127.0.0.1 OUT)
# - Creates tmpfs scratch (~/scratch, noexec,nosuid,nodev)
# - Ensures a real `org` command on PATH (no "bun run")
# - Builds the Debian container image (auto when Containerfile exists)
#
# Flags:
#   --no-sudo            user-only mode (skip system changes)
#   --sudo               force sudo mode (prompt if needed)
#   --no-harden          skip firewall + scratch
#   --egress-https       keep 443/tcp open after install (for pulls)
#   --build-image        force image build
#   --skip-image         skip image build
#   --image-tag TAG      tag for podman build (default: org:debian12)
#   --containerfile F    path to Containerfile (default: ./Containerfile)
#   --context DIR        podman build context (default: repo root)
#
# Env overrides:
#   ORG_INSTALL_SUDO=auto|yes|no   (default auto)
#   ORG_INSTALL_HARDEN=yes|no      (default yes)
#   ORG_SCRATCH_SIZE=1G
#   ORG_BUILD_IMAGE=auto|yes|no    (default auto → build if Containerfile exists)
#   ORG_IMAGE_TAG=org:debian12
#   ORG_CONTAINERFILE=Containerfile
#   ORG_BUILD_CONTEXT=<repo root>
#   ORG_KEEP_HTTPS=yes|no          (default no) leave 443 open after build
#   ORG_APP_ENTRY=src/app.ts       (fallback entry if package.json has no bin)

set -Eeuo pipefail

# --- enter repo root regardless of where we were invoked from ---
# Resolve this script (follows symlinks; works on macOS/Linux)
_self="${BASH_SOURCE[0]:-$0}"
while [ -L "$_self" ]; do
  target="$(readlink "$_self")"
  case "$target" in
    /*) _self="$target" ;;
    *)  _self="$(dirname "$_self")/$target" ;;
  esac
done
REPO_ROOT="$(cd "$(dirname "$_self")" && pwd)"

# Temporarily switch into the repo; restore on exit
pushd "$REPO_ROOT" >/dev/null
trap 'popd >/dev/null' EXIT
# --- end repo root switch ---

USE_SUDO="${ORG_INSTALL_SUDO:-auto}"
DO_HARDEN="${ORG_INSTALL_HARDEN:-yes}"
SCRATCH_SIZE="${ORG_SCRATCH_SIZE:-1G}"
BUILD_IMAGE="${ORG_BUILD_IMAGE:-auto}"
IMAGE_TAG="${ORG_IMAGE_TAG:-org:debian12}"
CONTAINERFILE="${ORG_CONTAINERFILE:-Containerfile}"
BUILD_CONTEXT="${ORG_BUILD_CONTEXT:-$REPO_ROOT}"
KEEP_HTTPS="${ORG_KEEP_HTTPS:-no}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-sudo)        USE_SUDO="no"; shift;;
    --sudo)           USE_SUDO="yes"; shift;;
    --no-harden)      DO_HARDEN="no"; shift;;
    --egress-https)   KEEP_HTTPS="yes"; shift;;
    --build-image)    BUILD_IMAGE="yes"; shift;;
    --skip-image)     BUILD_IMAGE="no"; shift;;
    --image-tag)      IMAGE_TAG="$2"; shift 2;;
    --containerfile)  CONTAINERFILE="$2"; shift 2;;
    --context)        BUILD_CONTEXT="$2"; shift 2;;
    *) echo "Unknown flag: $1" >&2; exit 2;;
  esac
done

say()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
am_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]]; }

SUDO=""
want_sudo() {
  case "$USE_SUDO" in
    yes)  return 0;;
    no)   return 1;;
    auto) am_root && return 0
          have sudo && (sudo -n true 2>/dev/null || sudo -v) && return 0
          return 1;;
  esac
}
enable_sudo() { if want_sudo; then SUDO="sudo"; am_root && SUDO=""; fi; }

apt_install() {
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -y
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}
ensure_service() {
  local svc="$1"
  if $SUDO systemctl is-enabled --quiet "$svc" 2>/dev/null; then
    $SUDO systemctl restart "$svc" || true
  else
    $SUDO systemctl enable --now "$svc" || true
  fi
}

# ---------- 1) privilege / bun ----------
say "Detecting privilege mode"
enable_sudo || warn "No sudo available; proceeding user-only"

if ! have bun; then
  say "Installing Bun (user)"
  curl -fsSL https://bun.sh/install | bash
fi
if ! echo ":$PATH:" | grep -q ":$HOME/.bun/bin:"; then
  echo 'export BUN_INSTALL="$HOME/.bun"' >> "$HOME/.bashrc"
  echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> "$HOME/.bashrc"
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# ---------- 2) system deps (sudo path) ----------
if want_sudo; then
  say "Installing system packages (curl git openssh-server ufw podman)"
  apt_install curl git openssh-server ufw podman uidmap slirp4netns sudo ca-certificates
  say "Enabling sshd"
  ensure_service ssh
fi

# ---------- 3) harden box (after deps so we don't break apt) ----------
if [[ "$DO_HARDEN" == "yes" ]] && want_sudo; then
  say "Applying firewall policy (deny IN/OUT; allow SSH IN; allow 127.0.0.1 OUT)"
  $SUDO ufw allow 22/tcp >/dev/null 2>&1 || true
  $SUDO ufw default deny incoming  >/dev/null 2>&1 || true
  $SUDO ufw default deny outgoing  >/dev/null 2>&1 || true
  $SUDO ufw allow out to 127.0.0.1 >/dev/null 2>&1 || true
  [[ "$KEEP_HTTPS" == "yes" ]] && $SUDO ufw allow out 443/tcp >/dev/null 2>&1 || true
  $SUDO ufw --force enable >/dev/null 2>&1 || true

  say "Creating tmpfs scratch at ~/scratch (${SCRATCH_SIZE}, noexec,nosuid,nodev)"
  SCRATCH_DIR="$HOME/scratch"
  $SUDO mkdir -p "$SCRATCH_DIR"
  FSTAB_LINE="tmpfs $SCRATCH_DIR tmpfs rw,noexec,nosuid,nodev,mode=700,size=${SCRATCH_SIZE} 0 0"
  if ! grep -qs "^[^#].*[[:space:]]$SCRATCH_DIR[[:space:]]" /etc/fstab; then
    echo "$FSTAB_LINE" | $SUDO tee -a /etc/fstab >/dev/null
  else
    $SUDO sed -i "s#^[^#].*[[:space:]]$SCRATCH_DIR[[:space:]].*\$#$FSTAB_LINE#" /etc/fstab
  fi
  $SUDO mount -o remount "$SCRATCH_DIR" 2>/dev/null || $SUDO mount "$SCRATCH_DIR" || true
fi

# ---------- 4) project deps & real `org` ----------
say "Installing project deps (bun install)"
bun install
say "Optional build (if present)"
bun run build || true

say "Exposing 'org' command (prefer package.json bin via bun global)"
bun install -g . || true
if ! command -v org >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  WRAP="$HOME/.local/bin/org"
  APP_ENTRY="${ORG_APP_ENTRY:-$REPO_ROOT/src/app.ts}"
  cat >"$WRAP" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec bun "$APP_ENTRY" "\$@"
EOF
  chmod +x "$WRAP"
  if ! echo ":$PATH:" | grep -q ":$HOME/.local/bin:"; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

# ---------- 5) build container image (smart) ----------
should_build_image() {
  case "$BUILD_IMAGE" in
    yes) return 0;;
    no)  return 1;;
    auto)
      [[ -f "$CONTAINERFILE" ]] && return 0
      return 1;;
  esac
}

if should_build_image; then
  say "Preparing Podman (rootless)"
  podman info >/dev/null 2>&1 || podman system migrate -f || true

  # If hardened, temporarily open DNS + HTTPS for pulls
  OPENED=()
  if [[ "$DO_HARDEN" == "yes" ]] && want_sudo; then
    for rule in "53/udp" "53/tcp" "443/tcp"; do
      if ! $SUDO ufw status | grep -q "$rule.*ALLOW OUT"; then
        say "Temporarily allowing outbound $rule for image pulls"
        $SUDO ufw allow out "$rule" >/dev/null 2>&1 || true
        OPENED+=("$rule")
      fi
    done
  fi

  say "Building container image: tag=${IMAGE_TAG}, file=${CONTAINERFILE}, context=${BUILD_CONTEXT}"
  if [[ ! -f "$CONTAINERFILE" ]]; then
    warn "Containerfile '${CONTAINERFILE}' not found; skipping build."
  else
    podman build --pull=always -t "$IMAGE_TAG" -f "$CONTAINERFILE" "$BUILD_CONTEXT"
  fi

  # Close temporary egress unless user wants https kept open
  if [[ "$DO_HARDEN" == "yes" ]] && want_sudo; then
    for rule in "${OPENED[@]}"; do
      [[ "$KEEP_HTTPS" == "yes" && "$rule" == "443/tcp" ]] && continue
      say "Closing temporary $rule egress"
      $SUDO ufw delete allow out "$rule" >/dev/null 2>&1 || true
    done
  fi
else
  say "Skipping image build (mode: $BUILD_IMAGE)"
fi

# ---------- 6) summary ----------
say "Ready."
if command -v org >/dev/null 2>&1; then
  say "Try:  org --ui console     (or: org --ui tmux)"
else
  warn "Add PATH for this session:  export PATH=\"$HOME/.bun/bin:$HOME/.local/bin:\$PATH\""
fi
if [[ "$DO_HARDEN" == "yes" ]] && want_sudo; then
  say "Firewall:"
  $SUDO ufw status verbose || true
fi
