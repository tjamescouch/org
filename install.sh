#!/usr/bin/env bash
# install.sh — one-stop installer/doctor/build/link for org
# Works on macOS (with podman-machine) and Debian/Ubuntu.
# Commands:
#   install        (default) doctor + machine (macOS) + build + link
#   build          build the container image
#   rebuild        build with --no-cache
#   link           install host wrappers (org, apply_patch)
#   unlink         remove host wrappers
#   doctor         check host + container prereqs; fix what we safely can
#   machine-init   (macOS) create/start 'podman machine'
#   machine-start  (macOS) start podman machine
#   machine-stop   (macOS) stop podman machine
#
# Options (for install/build):
#   --engine podman|docker     # default: podman
#   --image  NAME[:tag]        # default: localhost/org-build:debian-12
#   --prefix DIR               # default: /usr/local/bin (or $HOME/.local/bin with --user)
#   --user                     # install wrappers into $HOME/.local/bin (no sudo)
#   --platform linux/arm64|linux/amd64  # override build platform
#
# Exit codes: 1 general, 2 usage, 3 missing tool, 4 machine error, 5 build error

set -Eeuo pipefail

# ————————————————————————————————————————————————————————————————
# Helpers
# ————————————————————————————————————————————————————————————————
log()  { printf "[install] %s\n" "$*"; }
warn() { printf "[install][warn] %s\n" "$*" >&2; }
die()  { printf "[install][error] %s\n" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

need() {
  have "$1" || die "Missing tool: $1 (please install and re-run)."
}

SUDO=""
maybesudo() {
  if [ -w "$1" ]; then SUDO=""; else SUDO="sudo"; fi
}

# ————————————————————————————————————————————————————————————————
# Parse CLI
# ————————————————————————————————————————————————————————————————
CMD="${1:-install}"; shift || true

ENGINE="podman"
IMAGE="localhost/org-build:debian-12"
PREFIX="/usr/local/bin"
USER_PREFIX=0
PLATFORM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --engine)   ENGINE="${2:-}"; shift 2;;
    --image)    IMAGE="${2:-}"; shift 2;;
    --prefix)   PREFIX="${2:-}"; shift 2;;
    --user)     USER_PREFIX=1; PREFIX="$HOME/.local/bin"; shift;;
    --platform) PLATFORM="${2:-}"; shift 2;;
    -h|--help)
      sed -n '1,70p' "$0" | sed -n '1,60p' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) break;;
  esac
done

REPO="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"      # Darwin or Linux
ARCH="$(uname -m)"    # arm64, aarch64, x86_64, etc.

# Platform default for Podman build (Apple Silicon → linux/arm64)
if [ -z "${PLATFORM}" ]; then
  case "$ARCH" in
    arm64|aarch64) PLATFORM="linux/arm64" ;;
    x86_64|amd64)  PLATFORM="linux/amd64" ;;
    *) PLATFORM="" ;; # let engine decide
  esac
fi

# Files we will install/link
ORG_WRAPPER="$REPO/org"
PATCH_TOOL="$REPO/apply_patch"
CONTAINERFILE="$REPO/Containerfile"

# Sanity checks (these are required by the project layout)
[ -f "$ORG_WRAPPER" ]  || die "missing ./org at repo root"
[ -f "$PATCH_TOOL" ]   || die "missing ./apply_patch at repo root"
[ -f "$CONTAINERFILE" ]|| die "missing ./Containerfile at repo root"

# ————————————————————————————————————————————————————————————————
# Engine adapters
# ————————————————————————————————————————————————————————————————
engine_bin() {
  case "$ENGINE" in
    podman) echo "podman" ;;
    docker) echo "docker" ;;
    *) die "Unsupported engine: $ENGINE" ;;
  esac
}

engine_build() {
  local nocache="$1" ; shift
  local platflag=()
  [ -n "$PLATFORM" ] && platflag=(--platform "$PLATFORM")

  case "$ENGINE" in
    podman)
      ${ENGINE_BIN} build "${platflag[@]}" ${nocache:+--no-cache} \
        -t "$IMAGE" -f "$CONTAINERFILE" "$REPO" || return 5
      ;;
    docker)
      ${ENGINE_BIN} buildx build "${platflag[@]}" ${nocache:+--no-cache} \
        -t "$IMAGE" -f "$CONTAINERFILE" "$REPO" || return 5
      ;;
  esac
  return 0
}

engine_run() {
  # run an ephemeral command inside the image (for smoke tests)
  case "$ENGINE" in
    podman) ${ENGINE_BIN} run --rm "$IMAGE" bash -lc "$*";;
    docker) ${ENGINE_BIN} run --rm "$IMAGE" bash -lc "$*";;
  esac
}

# ————————————————————————————————————————————————————————————————
# OS‑specific prep
# ————————————————————————————————————————————————————————————————
doctor_common() {
  need git
  need bash

  case "$ENGINE" in
    podman) need podman ;;
    docker) need docker ;;
  esac

  if [ "$OS" = "Linux" ]; then
    # Debian/Ubuntu: suggest packages if missing
    if [ "$ENGINE" = "podman" ] && ! have podman; then
      warn "Podman not found. On Debian/Ubuntu: sudo apt-get install -y podman"
      return 3
    fi
  fi

  if [ "$OS" = "Darwin" ] && [ "$ENGINE" = "podman" ]; then
    have podman || die "Podman is required. Install via Homebrew: brew install podman"
    : # macOS handled by machine doctor below
  fi

  return 0
}

doctor_machine_macos() {
  [ "$OS" = "Darwin" ] || return 0
  [ "$ENGINE" = "podman" ] || return 0

  if ! podman machine inspect >/dev/null 2>&1; then
    warn "No podman machine detected on macOS."
    return 4
  fi

  if ! podman machine list 2>/dev/null | grep -q 'Running'; then
    log "Starting podman machine…"
    podman machine start || die "Failed to start podman machine (try: podman machine init; podman machine start)"
  fi
}

machine_init_macos() {
  [ "$OS" = "Darwin" ] || { warn "machine-init is macOS only"; return 0; }
  [ "$ENGINE" = "podman" ] || { warn "machine-init only for podman"; return 0; }

  local cpus="${ORG_MACHINE_CPUS:-4}"
  local mem="${ORG_MACHINE_MEM:-8192}"     # MB
  local disk="${ORG_MACHINE_DISK:-50}"     # GB

  if podman machine inspect >/dev/null 2>&1; then
    warn "podman machine already exists; skipping init"
  else
    log "Creating podman machine (cpus=$cpus, mem=${mem}MB, disk=${disk}GB)…"
    podman machine init --cpus "$cpus" --memory "$mem" --disk-size "$disk" || die "machine init failed"
  fi
  podman machine start || die "machine start failed"
}

# ————————————————————————————————————————————————————————————————
# Link/Unlink host wrappers
# ————————————————————————————————————————————————————————————————
do_link() {
  mkdir -p "$PREFIX"
  maybesudo "$PREFIX"

  $SUDO install -m 0755 "$PATCH_TOOL" "$PREFIX/apply_patch"
  log "installed apply_patch -> $PREFIX/apply_patch"

  # keep org as a symlink so upgrades use repo HEAD transparently
  $SUDO rm -f "$PREFIX/org"
  $SUDO ln -s "$ORG_WRAPPER" "$PREFIX/org"
  log "symlinked org -> $PREFIX/org -> $ORG_WRAPPER"

  # optional: repo hooks
  if [ -d "$REPO/.githooks" ]; then
    git -C "$REPO" config core.hooksPath .githooks || true
    chmod +x "$REPO/.githooks/"* 2>/dev/null || true
    log "git hooks enabled (core.hooksPath .githooks)"
  fi

  # show where binaries landed
  log "PATH hint: $PREFIX should be in your PATH"
}

do_unlink() {
  maybesudo "$PREFIX"
  $SUDO rm -f "$PREFIX/org" "$PREFIX/apply_patch"
  log "removed $PREFIX/org and $PREFIX/apply_patch"
}

# ————————————————————————————————————————————————————————————————
# Commands
# ————————————————————————————————————————————————————————————————
cmd_doctor() {
  doctor_common || true
  if [ "$OS" = "Darwin" ] && [ "$ENGINE" = "podman" ]; then
    if ! podman machine inspect >/dev/null 2>&1; then
      warn "No podman machine. Run: $0 machine-init"
    else
      doctor_machine_macos || true
    fi
  fi
  log "doctor: OK (or actionable hints printed above)"
}

cmd_build()   { engine_build "" || die "build failed"; }
cmd_rebuild() { engine_build "--no-cache" || die "rebuild failed"; }
cmd_link()    { do_link; }
cmd_unlink()  { do_unlink; }

cmd_machine_init()  { machine_init_macos; }
cmd_machine_start() { [ "$OS" = "Darwin" ] && podman machine start || true; }
cmd_machine_stop()  { [ "$OS" = "Darwin" ] && podman machine stop || true; }

cmd_install() {
  cmd_doctor
  if [ "$OS" = "Darwin" ] && [ "$ENGINE" = "podman" ]; then
    # auto-create a machine if none exists
    if ! podman machine inspect >/dev/null 2>&1; then
      machine_init_macos
    else
      doctor_machine_macos || true
    fi
  fi
  cmd_build

  # quick smoke test: ensure the image can run and PATH is sane
  log "smoke test: container PATH"
  engine_run 'echo "$PATH" && command -v bun && bun --version' || warn "smoke test failed (image still built)"

  cmd_link
  log "install complete. Try: org --help"
}

# ————————————————————————————————————————————————————————————————
# Dispatch
# ————————————————————————————————————————————————————————————————
case "$CMD" in
  install)        cmd_install ;;
  build)          cmd_build ;;
  rebuild)        cmd_rebuild ;;
  link)           cmd_link ;;
  unlink)         cmd_unlink ;;
  doctor)         cmd_doctor ;;
  machine-init)   cmd_machine_init ;;
  machine-start)  cmd_machine_start ;;
  machine-stop)   cmd_machine_stop ;;
  *) die "Unknown command: $CMD (run with --help)";;
esac
