#!/usr/bin/env bash
set -euo pipefail

# Ensure wclite binary exists
BIN=./build/wclite
if [[ ! -x "$BIN" ]]; then
  echo "wclite binary not found. Build it first."
  exit 1
fi

# Temporary directory for test files
TMPDIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

# Helper to compare wclite output with system wc
check_file() {
  local file=$1
  local expected
  expected=$(wc -l -w -c "$file" | awk '{print "lines="$1" words="$2" bytes="$3}')
  local actual
  actual=$("$BIN" "$file")
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $file"
    echo "  Expected: $expected"
    echo "  Got     : $actual"
    exit 1
  else
    echo "PASS: $file"
  fi
}

# 1. Empty file
touch "$TMPDIR/empty.txt"
check_file "$TMPDIR/empty.txt"

# 2. Simple ASCII text
cat >"$TMPDIR/ascii.txt" <<'EOF'
Hello world
This is a test
EOF
check_file "$TMPDIR/ascii.txt"

# 3. Long line (no newline)
printf 'a%.0s' {1..10000} >"$TMPDIR/longline.txt"
check_file "$TMPDIR/longline.txt"

# 4. Unicode text
printf 'こんにちは 世界\n' >"$TMPDIR/unicode.txt"
check_file "$TMPDIR/unicode.txt"

# 5. Larger file (1 MiB of random data)
dd if=/dev/urandom of="$TMPDIR/large.bin" bs=1K count=1024 status=none
check_file "$TMPDIR/large.bin"

echo "All tests passed."
