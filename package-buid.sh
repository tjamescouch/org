#!/usr/bin/env bash
# package-build.sh - build a versioned tarball of orgctl for Homebrew packaging
# MIT License

set -Eeuo pipefail

usage() {
  echo "Usage: $0 <version>"
  echo "Example: $0 0.2.0"
}

[[ $# -ge 1 ]] || { usage; exit 2; }
VERSION="$1"

ORGCTL_SRC="./orgctl"
[[ -f "$ORGCTL_SRC" ]] || { echo "ERROR: $ORGCTL_SRC not found" >&2; exit 1; }
chmod +x "$ORGCTL_SRC"

DIST_DIR="dist"
STAGE_DIR="$DIST_DIR/orgctl-$VERSION"
TARBALL="$DIST_DIR/orgctl-$VERSION.tar.gz"
SHAFILE="$TARBALL.sha256"

# Clean and stage
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp "$ORGCTL_SRC" "$STAGE_DIR/orgctl"

# Normalize line endings (strip CR if any)
perl -pi -e 's/\r$//' "$STAGE_DIR/orgctl"

# Avoid AppleDouble files on macOS
export COPYFILE_DISABLE=1

# Build tarball rooted at dist/
mkdir -p "$DIST_DIR"
tar -C "$DIST_DIR" -czf "$TARBALL" "orgctl-$VERSION"

# SHA256
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$TARBALL" | tee "$SHAFILE"
else
  sha256sum "$TARBALL" | tee "$SHAFILE"
fi

SHA=$(awk '{print $1}' "$SHAFILE")

cat <<EOF

✔ Built tarball: $TARBALL
✔ SHA256: $SHA

Next steps:
1. Create a GitHub Release in the **org repo** tagged v$VERSION
   Upload: $TARBALL

   (if you use GitHub CLI: 
      gh release create v$VERSION "$TARBALL" --title "orgctl $VERSION" --notes "orgctl $VERSION")

2. Update your tap repo (homebrew-org/Formula/org.rb):
   version "$VERSION"
   url "https://github.com/tjamescouch/org/releases/download/v$VERSION/$(basename "$TARBALL")"
   sha256 "$SHA"

3. Test locally:
   brew untap tjamescouch/org || true
   brew tap tjamescouch/org https://github.com/tjamescouch/homebrew-org
   brew install --build-from-source tjamescouch/org/org
   orgctl version

EOF

