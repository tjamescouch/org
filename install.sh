#!/usr/bin/env bash
# Unified installer for org: doctor + build + link + apply_patch shim
# Works on Debian/Ubuntu and macOS. Uses Podman (preferred) or Docker.
set -euo pipefail

# ---------- ui helpers ----------
C_RESET='\033[0m'; C_BOLD='\033[1m'
C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_BLUE='\033[34m'
say()   { printf "${C_BOLD}%s${C_RESET}\n" "$*"; }
ok()    { printf "${C_GREEN}✔ %s${C_RESET}\n" "$*"; }
warn()  { printf "${C_YELLOW}⚠ %s${C_RESET}\n" "$*"; }
err()   { printf "${C_RED}✘ %s${C_RESET}\n" "$*" >&2; }
step()  { printf "${C_BLUE}==> %s${C_RESET}\n" "$*"; }

# ---------- paths ----------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$REPO_DIR"

# Defaults (overridable)
ENGINE="${ORG_ENGINE:-}"
IMAGE="${ORG_IMAGE:-localhost/org-build:debian-12}"

BIN_CANDIDATES=(/usr/local/bin "$HOME/.local/bin")
BIN_DIR=""
for d in "${BIN_CANDIDATES[@]}"; do
  if [ -w "$d" ] || mkdir -p "$d" 2>/dev/null; then BIN_DIR="$d"; break; fi
done
if [ -z "$BIN_DIR" ]; then
  err "No writable bin dir found (tried: ${BIN_CANDIDATES[*]}). Try: sudo ./install.sh install"
  exit 1
fi

detect_engine() {
  if [ -n "$ENGINE" ]; then return 0; fi
  if command -v podman >/dev/null 2>&1; then ENGINE="podman"; return 0; fi
  if command -v docker >/dev/null 2>&1; then ENGINE="docker"; return 0; fi
  err "Neither podman nor docker found in PATH."
  exit 1
}

doctor() {
  step "Doctor"
  detect_engine
  ok "container engine: $ENGINE"

  # macOS podman machine hint
  if [[ "$OSTYPE" == darwin* ]] && [[ "$ENGINE" == "podman" ]]; then
    if ! podman machine inspect >/dev/null 2>&1; then
      warn "Podman machine not initialized. Run: podman machine init && podman machine start"
    else
      if ! podman machine ls | awk 'NR>1{print $4}' | grep -q Running; then
        warn "Podman machine not running. Run: podman machine start"
      else
        ok "podman machine running"
      fi
    fi
  fi

  if ! command -v git >/dev/null 2>&1; then
    err "git not found"
    exit 1
  fi
  ok "git found"
}

build_image() {
  step "Build image ($IMAGE)"
  if [[ "$ENGINE" == "podman" ]]; then
    podman build -t "$IMAGE" -f Containerfile "$REPO_DIR"
  else
    docker build -t "$IMAGE" -f Containerfile "$REPO_DIR"
  fi
  ok "image built: $IMAGE"
}

link_org() {
  step "Link CLI"
  local target="$BIN_DIR/org"
  # we want to link the repo's ./org shim (which sources .org/launcher/*)
  ln -snf "$REPO_DIR/org" "$target"
  chmod +x "$REPO_DIR/org"
  ok "linked: $target -> $REPO_DIR/org"
}

install_host_apply_patch() {
  step "Install host apply_patch fallback + repo wrapper"

  # 1) system-wide (or ~/.local/bin) portable fallback
  local sys_ap="$BIN_DIR/apply_patch"
  cat >"$sys_ap" <<"APFALLBACK"
#!/usr/bin/env bash
# Portable apply_patch fallback: reads unified diff from stdin or -f FILE
# and safe-applies it to the project git root using `git apply`.
set -euo pipefail

# Where to apply: prefer git toplevel; else current dir
WORK_ROOT="${ORG_WORK:-$(git -C "${PWD}" rev-parse --show-toplevel 2>/dev/null || pwd)}"

PATCH_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -f|--file) PATCH_FILE="${2:-}"; shift 2;;
    -) PATCH_FILE="-"; shift;;
    --) shift; break;;
    *) break;;
  esac
done

tmp="${TMPDIR:-/tmp}/ap.$$.patch"
trap 'rm -f "$tmp"' EXIT

if [ -n "${PATCH_FILE:-}" ] && [ "$PATCH_FILE" != "-" ]; then
  cat "$PATCH_FILE" > "$tmp"
else
  cat > "$tmp"
fi

# Extract candidate paths from the diff and block dangerous ones
mapfile -t paths < <(awk '/^diff --git a\//{print $4}' "$tmp" | sed -E 's#^b/##')
if [ "${#paths[@]}" -eq 0 ]; then
  echo "apply_patch: no file paths detected (expects unified diff)" >&2
  exit 1
fi

deny_regex='^(\.git/|\.org/|/|\.{2}(/|$)|.*\x00.*)'
viol=""
for p in "${paths[@]}"; do
  p="${p#./}"
  if [[ "$p" =~ $deny_regex ]]; then
    viol+="$p\n"
  fi
done
if [ -n "$viol" ]; then
  printf 'apply_patch: path policy violation(s):\n%s' "$viol" >&2
  exit 3
fi

git -C "$WORK_ROOT" apply --index --whitespace=nowarn --check "$tmp"
git -C "$WORK_ROOT" apply --index --whitespace=nowarn "$tmp"
echo "apply_patch: OK"
APFALLBACK
  chmod +x "$sys_ap"
  ok "installed fallback: $sys_ap"

  # 2) repo-root wrapper (so tests or tools that invoke ./apply_patch keep working)
  local repo_ap="$REPO_DIR/apply_patch"
  if [ ! -f "$repo_ap" ]; then
    cat >"$repo_ap" <<"APWRAP"
#!/usr/bin/env bash
# Wrapper: use system apply_patch (installed by installer)
exec apply_patch "$@"
APWRAP
    chmod +x "$repo_ap"
    ok "created repo wrapper: $repo_ap"
  else
    ok "repo wrapper already present: $repo_ap"
  fi
}

rebuild() {
  step "Rebuild image (no cache)"
  detect_engine
  if [[ "$ENGINE" == "podman" ]]; then
    podman build --no-cache --pull -t "$IMAGE" -f Containerfile "$REPO_DIR"
  else
    docker build --no-cache --pull -t "$IMAGE" -f Containerfile "$REPO_DIR"
  fi
  ok "image rebuilt: $IMAGE"
}

uninstall() {
  step "Uninstall"
  rm -f "$BIN_DIR/org" "$BIN_DIR/apply_patch" 2>/dev/null || true
  ok "removed links from $BIN_DIR"
  warn "To remove the container image: ${ENGINE:-podman} rmi $IMAGE"
}

usage() {
  cat <<EOF
Usage: $0 [command]

Commands:
  install     Doctor + build + link + install apply_patch
  build       Build image
  rebuild     Build image (no cache)
  doctor      Check environment
  link        Link org into PATH
  uninstall   Remove links (and print image removal hint)

Environment overrides:
  ORG_ENGINE   podman|docker (default: auto-detect, prefer podman)
  ORG_IMAGE    image tag (default: $IMAGE)
EOF
}

cmd="${1:-install}"
case "$cmd" in
  doctor)    doctor ;;
  build)     doctor; build_image ;;
  link)      link_org ;;
  rebuild)   doctor; rebuild ;;
  uninstall) uninstall ;;
  install)
    doctor
    build_image
    link_org
    install_host_apply_patch
    ok "Install complete. Try: org --prompt 'hello'"
    ;;
  *) usage; exit 2 ;;
esac
