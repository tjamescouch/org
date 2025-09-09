#!/usr/bin/env bash
# scripts/reinstall-org-macos.sh
# Clean reset + full re-install for org (macOS host).
# - Removes old Lima VM, logs, caches (optional)
# - Reinstalls socket_vmnet and lima
# - (Optionally) untaps any org-related taps
# - Recreates VM and runs ./orgctl quickstart --verbose
#
# Usage:
#   bash scripts/reinstall-org-macos.sh           # standard reset + install
#   bash scripts/reinstall-org-macos.sh --deep    # also wipe Lima caches (bigger download)
#   NO_TAIL=true ./scripts/reinstall-org-macos.sh # keep serial log quiet
set -Eeuo pipefail

# ---------- toggles ----------
DEEP="${1:-}"              # "--deep" to clear Lima caches
UNTAP_LIST="${UNTAP_LIST:-tjamescouch/org}"  # taps to untap if present (comma-separated)

# ---------- helpers ----------
say(){ printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn(){ printf "\033[1;33m!!\033[0m %s\n" "$*" >&2; }
die(){ printf "\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || die "Missing: $1"; }

is_macos(){ [[ "$(uname -s)" == "Darwin" ]]; }
brew_has(){ brew list --formula 2>/dev/null | grep -qx "$1"; }
tap_present(){ brew tap 2>/dev/null | grep -qx "$1"; }

# ---------- sanity ----------
is_macos || die "This reset script targets macOS."
need bash
if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew not found. Install from https://brew.sh and rerun."
fi

# ---------- repo root / orgctl ----------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORGCTL="$REPO_ROOT/orgctl"
[[ -x "$ORGCTL" ]] || chmod +x "$ORGCTL"
[[ -f "$REPO_ROOT/.org/config/org.lima.yaml" ]] || die "Missing $REPO_ROOT/.org/config/org.lima.yaml"

# ---------- stop tails ----------
say "Stopping any lingering serial log tails"
pkill -f '/\.lima/.*serial.*\.log' 2>/dev/null || true

# ---------- tear down Lima VM(s) ----------
for NAME in org.lima org; do
  say "Stopping Lima instance: $NAME (if exists)"
  limactl stop "$NAME" >/dev/null 2>&1 || true
  say "Deleting Lima instance: $NAME (if exists)"
  limactl delete -f "$NAME" >/dev/null 2>&1 || true
done
rm -rf "$HOME/.lima/org.lima"* 2>/dev/null || true

# (optional) clear Lima caches to force fresh base image
if [[ "$DEEP" == "--deep" ]]; then
  say "Deep-cleaning Lima caches (this will force re-downloads)"
  rm -rf "$HOME/Library/Caches/lima"/* 2>/dev/null || true
fi

# ---------- (optional) untap org taps ----------
IFS=',' read -r -a TAPS <<<"$UNTAP_LIST"
for TAP in "${TAPS[@]}"; do
  [[ -z "$TAP" ]] && continue
  if tap_present "$TAP"; then
    say "Untapping Homebrew tap: $TAP"
    brew untap -f "$TAP" || warn "Untap $TAP failed (continuing)"
  fi
done

# ---------- reinstall socket_vmnet ----------
say "Ensuring socket_vmnet (binary install + service)"
if ! brew_has socket_vmnet; then
  brew install socket_vmnet
else
  brew reinstall socket_vmnet || true
fi

# Copy real binary to /opt (avoid symlink issues with Lima 1.2.x)
sudo mkdir -p /opt/socket_vmnet/bin
sudo cp -f "$(brew --prefix)/opt/socket_vmnet/bin/socket_vmnet" /opt/socket_vmnet/bin/socket_vmnet
sudo chmod 755 /opt/socket_vmnet/bin/socket_vmnet

# Restart service
say "Restarting socket_vmnet service"
sudo brew services restart socket_vmnet

# ---------- reinstall lima ----------
say "Ensuring Lima CLI"
if ! brew_has lima; then
  brew install lima
else
  brew reinstall lima || true
fi

# ---------- print versions ----------
say "Versions: $(limactl --version 2>/dev/null | tr -d '\n') ; socket_vmnet: $(/opt/socket_vmnet/bin/socket_vmnet -v 2>&1 || true)"

# ---------- start fresh VM (non-interactive) ----------
CFG="$REPO_ROOT/.org/config/org.lima.yaml"
say "Creating Lima instance from $CFG (first run; --tty=false, synchronous)…"
# Lima sometimes exits non-zero even when boot proceeds; treat non-zero as soft.
set +e
yes | limactl start --name org.lima --tty=false "$CFG"
rc=$?
set -e
if (( rc != 0 )); then
  warn "limactl start exited with $rc; continuing to wait for SSH (startup often continues)."
fi

# ---------- wait for SSH ----------
sleep 5
say "Waiting for VM SSH to be ready"
i=0; timeout="${ORG_WAIT_SSH_TIMEOUT:-360}"
while (( i < timeout )); do
  if limactl shell org.lima -- true >/dev/null 2>&1; then
    say "SSH is ready."
    break
  fi
  printf "."
  ((i+=2))
  sleep 2
done
echo ""
(( i < timeout )) || die "Timed out waiting for SSH. See: tail -f ~/.lima/org.lima/serial*.log"

# ---------- optionally tail serial log ----------
if [[ "${NO_TAIL:-false}" != "true" ]]; then
  LOG="$(ls -1t "$HOME/.lima/org.lima"/serial*.log 2>/dev/null | head -n1 || true)"
  if [[ -n "$LOG" ]]; then
    say "Tailing VM console log ($LOG)… (Ctrl+C to stop tail; install continues)"
    tail -f "$LOG" &
    TAIL_PID=$!
    trap 'kill "$TAIL_PID" 2>/dev/null || true' EXIT INT TERM
  fi
fi

# ---------- poll provisioning (wait until org exists) ----------
say "Waiting for provisioning checkpoints (sudo,bun,org,img,cloud,ufw) …"
elapsed=0; last=""
while :; do
  state="$(limactl shell org.lima -- bash -lc '
    set +e
    s=$(command -v sudo >/dev/null && echo y || echo n)
    b=$(command -v bun  >/dev/null && echo y || echo n)
    o=$(command -v org  >/dev/null && echo y || echo n)
    if command -v podman >/dev/null 2>&1; then podman image exists org:debian12 >/dev/null 2>&1 && i=y || i=n; else i=n; fi
    if command -v cloud-init >/dev/null 2>&1; then cloud-init status 2>/dev/null | grep -q "done" && c=done || c=running; else c=na; fi
    if command -v ufw >/dev/null 2>&1; then ufw status 2>/dev/null | grep -q "Status: active" && u=on || u=off; else u=na; fi
    echo "sudo=$s bun=$b org=$o img=$i cloud=$c ufw=$u"
  ' 2>/dev/null || true)"
  if [[ -n "$state" && "$state" != "$last" ]]; then
    echo ""
    say "[provision] $state  (t+${elapsed}s)"
    last="$state"
  else
    printf "."
  fi
  [[ "$state" == *"org=y"* ]] && { echo ""; say "Provisioning checkpoint reached: org installed."; break; }
  sleep 5; ((elapsed+=5))
  if (( elapsed > ${ORG_WAIT_INSTALL_TIMEOUT:-1800} )); then
    echo ""; die "Timed out waiting for provisioning. Check ~/.lima/org.lima/serial*.log"
  fi
done

# ---------- final banner ----------
GUEST_PWD="/home/${USER}.linux/dev/$(basename "$REPO_ROOT")"
cat <<EOF

┌────────────── org VM (ready) ─────────────────────────
│ Connect:   limactl shell org.lima
│ Project:   cd "$GUEST_PWD"   # or: cd ~/dev/org
│ Run org:   org --ui console
└───────────────────────────────────────────────────────
EOF

# Optionally auto-attach once ready (comment out if you prefer manual)
# limactl shell org.lima -- bash -ilc "cd \"$GUEST_PWD\" 2>/dev/null || cd \"\$HOME/dev/org\" 2>/dev/null || cd ~; exec bash -i -l"

