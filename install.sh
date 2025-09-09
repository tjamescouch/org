#!/usr/bin/env bash
# install.sh — smart, idempotent guest setup for `org`
# MIT License

set -Eeuo pipefail

# ---------- repo root ----------
_self="${BASH_SOURCE[0]:-$0}"
while [ -L "$_self" ]; do
  t="$(readlink "$_self")"; case "$t" in /*) _self="$t";; *) _self="$(dirname "$_self")/$t";; esac
done
REPO_ROOT="$(cd "$(dirname "$_self")" && pwd)"
pushd "$REPO_ROOT" >/dev/null
trap 'popd >/dev/null' EXIT

# ---------- log helpers ----------
say()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
am_root(){ [[ "${EUID:-$(id -u)}" -eq 0 ]]; }

# ---------- knobs ----------
USE_SUDO="${ORG_INSTALL_SUDO:-auto}"
DO_HARDEN="${ORG_INSTALL_HARDEN:-yes}"
SCRATCH_SIZE="${ORG_SCRATCH_SIZE:-1G}"
BUILD_IMAGE="${ORG_BUILD_IMAGE:-auto}"
IMAGE_TAG="${ORG_IMAGE_TAG:-org:debian12}"
CONTAINERFILE="${ORG_CONTAINERFILE:-Containerfile}"
BUILD_CONTEXT="${ORG_BUILD_CONTEXT:-$REPO_ROOT}"
KEEP_HTTPS="${ORG_KEEP_HTTPS:-no}"
LAUNCH="${ORG_INSTALL_LAUNCH:-auto}"
UI="${ORG_INSTALL_UI:-console}"

# Host loopback as seen from Lima guest; can override
HOST_LO_IP="${ORG_HOST_LO_IP:-192.168.5.2}"
HOST_LLM_PORT="${ORG_HOST_LLM_PORT:-11434}"
# Final value to persist & export for org/LLM access (overridable)
ORG_LLM_BASE_URL="${ORG_LLM_BASE_URL:-http://${HOST_LO_IP}:${HOST_LLM_PORT}}"

# ---------- flags ----------
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
    --launch)         LAUNCH="yes"; shift;;
    --no-launch)      LAUNCH="no"; shift;;
    --ui)             UI="$2"; shift 2;;
    *) die "Unknown flag: $1";;
  esac
done

# ---------- sudo handling ----------
SUDO=""
want_sudo() {
  case "$USE_SUDO" in
    yes) return 0;;
    no)  return 1;;
    auto)
      am_root && return 0
      have sudo && (sudo -n true 2>/dev/null || sudo -v) && return 0
      return 1;;
  esac
}
enable_sudo(){ if want_sudo; then SUDO="sudo"; am_root && SUDO=""; fi; }

# ---------- apt helpers ----------
APT_ENV=(env DEBIAN_FRONTEND=noninteractive)
apt_install() {
  $SUDO "${APT_ENV[@]}" apt-get update -y
  $SUDO "${APT_ENV[@]}" apt-get install -y --no-install-recommends "$@"
}
ensure_service(){ local s="$1"; $SUDO systemctl enable --now "$s" >/dev/null 2>&1 || $SUDO systemctl restart "$s" >/dev/null 2>&1 || true; }

# ---------- UFW bootstrap (handles "already locked" VMs) ----------
BOOT_OPENED=()
ufw_active()          { have ufw && ufw status 2>/dev/null | grep -q "Status: active"; }
ufw_denies_outgoing() { have ufw && ufw status verbose 2>/dev/null | grep -qi "Default: deny (outgoing)"; }

open_bootstrap_egress_if_needed() {
  if ufw_active && ufw_denies_outgoing; then
    if ! want_sudo; then
      die "UFW is active (deny outgoing) and no sudo to open DNS/HTTPS.
Re-run with ORG_INSTALL_SUDO=yes ./install.sh
or run: sudo ufw allow out 53/udp 53/tcp 443/tcp"
    fi
    for rule in "53/udp" "53/tcp" "443/tcp"; do
      if ! ufw status | grep -q "$rule.*ALLOW OUT"; then
        say "Temporarily allowing outbound $rule for bootstrap"
        $SUDO ufw allow out "$rule" >/dev/null 2>&1 || true
        BOOT_OPENED+=("$rule")
      fi
    done
  fi
}
close_bootstrap_egress() {
  if [[ "${#BOOT_OPENED[@]}" -gt 0 ]] && want_sudo; then
    for rule in "${BOOT_OPENED[@]}"; do
      [[ "$KEEP_HTTPS" == "yes" && "$rule" == "443/tcp" ]] && continue
      say "Closing temporary bootstrap $rule"
      $SUDO ufw delete allow out "$rule" >/dev/null 2>&1 || true
    done
  fi
}

# ---------- minimal prereqs for Bun ----------
ensure_bun_prereqs() {
  local need=()
  have curl || need+=(curl)
  have unzip || need+=(unzip)
  dpkg -s ca-certificates >/dev/null 2>&1 || need+=(ca-certificates)
  if [[ "${#need[@]}" -gt 0 ]]; then
    if want_sudo; then
      say "Installing Bun prerequisites: ${need[*]}"
      apt_install "${need[@]}"
    else
      die "Missing prerequisites (${need[*]}), and no sudo available.
Install them (e.g., sudo apt-get install -y ${need[*]}) or re-run with ORG_INSTALL_SUDO=yes."
    fi
  fi
}

say "Detecting privilege mode"; enable_sudo || warn "No sudo; proceeding user-only (no system changes)"

# =====================================================================
# 1) Bootstrap network (if UFW already denies egress) + ensure prereqs
# =====================================================================
open_bootstrap_egress_if_needed
ensure_bun_prereqs

# =====================================================================
# 2) Bun (user)
# =====================================================================
say "Installing Bun (user)"
curl -fsSL https://bun.sh/install | bash || die "Bun install failed"
if ! echo ":$PATH:" | grep -q ":$HOME/.bun/bin:"; then
  echo 'export BUN_INSTALL="$HOME/.bun"' >> "$HOME/.bashrc"
  echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> "$HOME/.bashrc"
  export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"
fi

# =====================================================================
# 3) System deps
# =====================================================================
if want_sudo; then
  say "Installing system packages (curl git openssh-server ufw podman)"
  apt_install curl git openssh-server ufw podman uidmap slirp4netns ca-certificates sudo unzip
  say "Ensuring sshd is enabled"; ensure_service ssh
fi

# Remove temporary DNS/HTTPS allows, we’ll re-open granularly later if needed.
close_bootstrap_egress

# =====================================================================
# 4) Hardening (UFW + tmpfs scratch) — final state by end of script
# =====================================================================
if [[ "$DO_HARDEN" == "yes" ]] && want_sudo; then
  say "Applying firewall (deny IN/OUT; allow SSH IN; allow 127.0.0.1 OUT)"
  $SUDO ufw allow 22/tcp >/dev/null 2>&1 || true
  $SUDO ufw default deny incoming  >/dev/null 2>&1 || true
  $SUDO ufw default deny outgoing  >/dev/null 2>&1 || true
  $SUDO ufw allow out to 127.0.0.1 >/dev/null 2>&1 || true
  # keep HTTPS if explicitly requested
  [[ "$KEEP_HTTPS" == "yes" ]] && $SUDO ufw allow out 443/tcp >/dev/null 2>&1 || true
  # Allow guest -> host LLM on 11434/tcp (or override via ORG_HOST_* env)
  $SUDO ufw allow out to "$HOST_LO_IP" proto tcp port "$HOST_LLM_PORT" >/dev/null 2>&1 || true
  $SUDO ufw --force enable >/dev/null 2>&1 || true

  say "Creating tmpfs scratch at ~/scratch ($SCRATCH_SIZE, noexec,nosuid,nodev)"
  SCRATCH="$HOME/scratch"
  $SUDO mkdir -p "$SCRATCH"
  FSTAB_LINE="tmpfs $SCRATCH tmpfs rw,noexec,nosuid,nodev,mode=700,size=${SCRATCH_SIZE} 0 0"
  if ! grep -qs "^[^#].*[[:space:]]$SCRATCH[[:space:]]" /etc/fstab; then
    echo "$FSTAB_LINE" | $SUDO tee -a /etc/fstab >/dev/null
  else
    $SUDO sed -i "s#^[^#].*[[:space:]]$SCRATCH[[:space:]].*\$#$FSTAB_LINE#" /etc/fstab
  fi
  $SUDO mount -o remount "$SCRATCH" 2>/dev/null || $SUDO mount "$SCRATCH" || true
fi

# =====================================================================
# 4b) Persist LLM URL for org (and current shell)
# =====================================================================
say "Configuring ORG_LLM_BASE_URL → ${ORG_LLM_BASE_URL}"
mkdir -p "$HOME/.bashrc.d"
cat >"$HOME/.bashrc.d/30-org-llm.sh" <<EOF
# org: host LLM endpoint (Lima exposes host-lo as ${HOST_LO_IP})
export ORG_LLM_BASE_URL="${ORG_LLM_BASE_URL}"
EOF
# ensure snippet loader exists
grep -q ".bashrc.d" "$HOME/.bashrc" 2>/dev/null || \
  printf '\nfor f in ~/.bashrc.d/*.sh; do [ -r "$f" ] && . "$f"; done\n' >> "$HOME/.bashrc"
# export for this session too
export ORG_LLM_BASE_URL="${ORG_LLM_BASE_URL}"

# =====================================================================
# 5) Project deps & org
# =====================================================================
say "Installing project deps (bun install)"; bun install
say "Optional build (if present)"; bun run build || true
say "Exposing 'org' command (prefer package.json bin via Bun global)"
bun install -g . || true
if ! command -v org >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  APP_ENTRY="${ORG_APP_ENTRY:-$REPO_ROOT/src/app.ts}"
  cat >"$HOME/.local/bin/org" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec bun "${ORG_APP_ENTRY:-'"$REPO_ROOT"'/src/app.ts}" "$@"
EOF
  chmod +x "$HOME/.local/bin/org"
  if ! echo ":$PATH:" | grep -q ":$HOME/.local/bin:"; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

# =====================================================================
# 6) Build container image (open 53/443 temporarily during pulls)
# =====================================================================
should_build_image() { case "$BUILD_IMAGE" in yes) return 0;; no) return 1;; auto) [[ -f "$CONTAINERFILE" ]];; esac; }
if should_build_image; then
  say "Preparing Podman (rootless)"; podman info >/dev/null 2>&1 || podman system migrate -f || true
  OPENED=()
  if [[ "$DO_HARDEN" == "yes" ]] && want_sudo; then
    for rule in "53/udp" "53/tcp" "443/tcp"; do
      if ! $SUDO ufw status | grep -q "$rule.*ALLOW OUT"; then
        say "Temporarily allowing outbound $rule for image pulls"
        $SUDO ufw allow out "$rule" >/dev/null 2>&1 || true; OPENED+=("$rule")
      fi
    done
  fi
  say "Building container image (tag=$IMAGE_TAG, file=$CONTAINERFILE)"
  if [[ -f "$CONTAINERFILE" ]]; then
    podman build --pull=always -t "$IMAGE_TAG" -f "$CONTAINERFILE" "$BUILD_CONTEXT"
  else
    warn "Containerfile '$CONTAINERFILE' not found; skipping build."
  fi
  if [[ "$DO_HARDEN" == "yes" ]] && want_sudo; then
    for rule in "${OPENED[@]}"; do
      [[ "$KEEP_HTTPS" == "yes" && "$rule" == "443/tcp" ]] && continue
      say "Closing temporary $rule egress"; $SUDO ufw delete allow out "$rule" >/dev/null 2>&1 || true
    done
  fi
else
  say "Skipping image build (mode=$BUILD_IMAGE)"
fi

# =====================================================================
# 7) Launch
# =====================================================================
maybe_launch_org() {
  command -v org >/dev/null 2>&1 || { warn "'org' not on PATH yet"; return 0; }
  [[ "$UI" == "tmux" ]] && command -v tmux >/dev/null 2>&1 || UI="console"
  is_tty=0; [[ -t 0 && -t 1 ]] && is_tty=1
  case "$LAUNCH" in
    yes) say "Launching org (--ui $UI)…"; exec org --ui "$UI" ;;
    no)  say "Install finished. Run:  org --ui $UI" ;;
    auto)
      if [[ "$is_tty" -eq 1 ]]; then
        read -r -p "$(printf 'Launch org now (--ui %s)? [Y/n] ' "$UI")" ans; ans=${ans:-Y}
        [[ "$ans" =~ ^[Yy]$ ]] && { say "Launching org…"; exec org --ui "$UI"; } || say "Skipping launch."
      else
        say "Install finished. Run:  org --ui $UI"
      fi
      ;;
  esac
}
say "Ready."
maybe_launch_org
