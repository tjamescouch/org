#!/usr/bin/env bash
# Robust patch applier for AI-generated patches.
# Usage:
#   apply_patch [--dry-run] [--verbose]
#   …then provide patch on STDIN (e.g., via heredoc).
#
# Features:
#   - Understands "*** Begin Patch" / "*** Update File: foo" format
#   - Handles Add/Update/Delete/Rename
#   - Falls back to git/patch for standard unified diffs
#   - Fuzzy hunk application (whitespace-insensitive) when needed
#   - Restores stdin state after interactive prompts elsewhere in your app

set -euo pipefail

DRY_RUN=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --verbose|-v) VERBOSE=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

tmp_patch="$(mktemp -t apply_patch.XXXXXX)"
trap 'rm -f "$tmp_patch"' EXIT

# Read entire stdin to a tempfile so we can process multiple times.
cat > "$tmp_patch"

if (( VERBOSE )); then
  echo "[apply_patch] captured $(wc -c <"$tmp_patch") bytes" >&2
fi

# Quick path: if this looks like a standard unified diff, try system tools first.
if grep -Eq '^(diff --git|--- |+++ |@@ )' "$tmp_patch"; then
  if (( VERBOSE )); then echo "[apply_patch] appears to be standard diff; trying git apply/patch" >&2; fi
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if (( DRY_RUN )); then
      git apply --check "$tmp_patch" && echo "[apply_patch] git apply --check: clean" >&2 || { echo "[apply_patch] git apply --check failed" >&2; exit 1; }
      exit 0
    else
      if git apply "$tmp_patch"; then
        echo "[apply_patch] applied via git apply" >&2
        exit 0
      fi
    fi
  fi
  # Fallback to POSIX patch (best-effort)
  if command -v patch >/dev/null 2>&1; then
    if (( DRY_RUN )); then
      patch --dry-run -p0 < "$tmp_patch" >/dev/null && echo "[apply_patch] patch --dry-run: clean" >&2 || { echo "[apply_patch] patch --dry-run failed" >&2; exit 1; }
      exit 0
    else
      if patch -p0 < "$tmp_patch"; then
        echo "[apply_patch] applied via patch(1)" >&2
        exit 0
      fi
    fi
  fi
  if (( VERBOSE )); then echo "[apply_patch] standard diff path failed; falling back to smart parser" >&2; fi
fi

# Smart parser for "*** Begin Patch" style and noisy outputs.
# Implemented in Python for reliability; requires python3.
if ! command -v python3 >/dev/null 2>&1; then
  echo "[apply_patch] python3 is required for smart parsing" >&2
  exit 1
fi

PY_DEBUG="${APPLY_PATCH_DEBUG:-0}"
python3 - "$tmp_patch" "$DRY_RUN" "$VERBOSE" "$PY_DEBUG" <<'PYCODE'
import sys, os, re, shutil, time, json

patch_path = sys.argv[1]
DRY_RUN = sys.argv[2] == "1"
VERBOSE = sys.argv[3] == "1"
PY_DEBUG = sys.argv[4] == "1"

def dbg(*a):
    if VERBOSE or PY_DEBUG:
        print("[apply_patch.py]", *a, file=sys.stderr)

def read_text(p):
    with open(p, "r", encoding="utf-8", errors="ignore") as f:
        return f.read()

text = read_text(patch_path)

# Extract the core patch payload.
m = re.search(r'^\*\*\*\s*Begin Patch\s*$([\s\S]*?)^\*\*\*\s*End Patch\s*$', text, re.M)
if m:
    payload = m.group(1)
else:
    # If no explicit markers, try to isolate likely patch sections by removing obvious chatter.
    # Keep lines that look like diff lines, Update/Add/Delete/Rename headers, code blocks, or hunk markers.
    keep = []
    for line in text.splitlines():
        if re.match(r'^\s*(\*\*\*\s*(Update|Add|Delete|Rename) File:|@@|[-+ ]|```|diff --git|--- |\+\+\+ )', line):
            keep.append(line)
    payload = "\n".join(keep)

# Strip code fences if present
payload = re.sub(r'```[a-zA-Z0-9-]*\s*', '', payload)
payload = re.sub(r'```', '', payload)

# Normalize Windows CRLF
payload = payload.replace('\r\n', '\n').replace('\r', '\n')

# Operation model: list of {"op": "update|add|delete|rename", "path": ..., ...}
ops = []

# If payload looks like standard diff, let earlier path handle it, but we fell through here.
# We'll still try to apply via a simplified parser.
def start_op(optype, path):
    ops.append({"op": optype, "path": path, "hunks": []})
    return ops[-1]

def ensure_dirs(p):
    d = os.path.dirname(p)
    if d and not os.path.exists(d):
        os.makedirs(d, exist_ok=True)

def normalize_ws(s):
    # compress internal whitespace for fuzzy match
    return re.sub(r'\s+', ' ', s).strip()

def find_subseq(hay, needle):
    # exact
    n = len(needle)
    if n == 0:
        return -1
    for i in range(0, len(hay) - n + 1):
        if hay[i:i+n] == needle:
            return i
    return -1

def find_subseq_fuzzy(hay, needle):
    n = len(needle)
    if n == 0:
        return -1
    H = [normalize_ws(x) for x in hay]
    N = [normalize_ws(x) for x in needle]
    for i in range(0, len(H) - n + 1):
        if H[i:i+n] == N:
            return i
    return -1

lines = payload.splitlines()
i = 0

def parse_path_after(header, line):
    # supports either "Update File: path" or "Rename File: old -> new"
    rest = line.split(header, 1)[1].strip()
    return rest

while i < len(lines):
    line = lines[i].strip('\n')
    if not line.startswith('*** '):
        i += 1
        continue

    if 'Update File:' in line:
        path = parse_path_after('Update File:', line)
        cur = start_op('update', path)
        i += 1
        # read hunks until next *** or EOF
        while i < len(lines) and not lines[i].startswith('*** '):
            if lines[i].startswith('@@'):
                # collect a hunk
                i += 1
                minus, plus, ctx = [], [], []
                while i < len(lines) and not lines[i].startswith('@@') and not lines[i].startswith('*** '):
                    ln = lines[i]
                    if ln.startswith('+'):
                        plus.append(ln[1:])
                    elif ln.startswith('-'):
                        minus.append(ln[1:])
                    elif ln.startswith(' '):
                        c = ln[1:]
                        minus.append(c); plus.append(c)
                        ctx.append(c)
                    else:
                        # blank or noisy lines: treat blank as context to keep spacing
                        if ln.strip() == '':
                            minus.append(''); plus.append('')
                    i += 1
                cur["hunks"].append({"minus": minus, "plus": plus, "ctx": ctx})
                continue
            else:
                i += 1
        continue

    if 'Add File:' in line:
        path = parse_path_after('Add File:', line)
        cur = start_op('add', path)
        i += 1
        buf = []
        while i < len(lines) and not lines[i].startswith('*** '):
            ln = lines[i]
            buf.append(ln)
            i += 1
        # Heuristic: if most non-empty lines start with '+', strip them.
        non_empty = [b for b in buf if b.strip() != '']
        plus_pref = sum(1 for b in non_empty if b.startswith('+'))
        if non_empty and plus_pref / float(len(non_empty)) > 0.6:
            buf = [b[1:] if b.startswith('+') else b for b in buf]
        # Strip any leading/trailing blank lines from the captured content
        while buf and buf[0].strip() == '': buf.pop(0)
        while buf and buf[-1].strip() == '': buf.pop()
        cur["content"] = "\n".join(buf) + ("\n" if buf else "")
        continue

    if 'Delete File:' in line:
        path = parse_path_after('Delete File:', line)
        start_op('delete', path)
        i += 1
        continue

    if 'Rename File:' in line:
        rest = parse_path_after('Rename File:', line)
        # support "old -> new" or "old to new"
        m = re.match(r'(.+?)(?:\s*->\s*|\s+to\s+)(.+)$', rest)
        if not m:
            dbg("bad rename spec:", rest)
            i += 1
            continue
        ops.append({"op": "rename", "from": m.group(1).strip(), "to": m.group(2).strip()})
        i += 1
        continue

    i += 1

if not ops:
    print("[apply_patch] No operations recognized in input.", file=sys.stderr)
    sys.exit(1)

dbg("ops:", json.dumps(ops, indent=2))

def backup(p):
    if not os.path.exists(p):
        return
    ts = time.strftime("%Y%m%d-%H%M%S")
    bak = f"{p}.bak.{ts}"
    ensure_dirs(bak)
    shutil.copy2(p, bak)
    dbg("backup:", bak)

def write_file(path, content):
    ensure_dirs(path)
    if DRY_RUN:
        dbg(f"[dry-run] would write {path} ({len(content)} bytes)")
        return True
    backup(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True

def apply_update(path, hunks):
    if not os.path.exists(path):
        print(f"[apply_patch] update failed: {path} not found", file=sys.stderr)
        return False
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.read().splitlines()
    for h in hunks:
        minus = h.get("minus", [])
        plus = h.get("plus", [])
        if not minus and plus:
            # append at end when we have only additions
            lines.extend(plus)
            continue
        # Find exact block first
        idx = find_subseq(lines, minus)
        if idx == -1:
            idx = find_subseq_fuzzy(lines, minus)
        if idx == -1:
            # As a last resort, try to find by first line only (exact), then expand
            if minus:
                try:
                    idx_candidates = [i for i, L in enumerate(lines) if L == minus[0]]
                except Exception:
                    idx_candidates = []
                placed = False
                for i0 in idx_candidates:
                    if lines[i0:i0+len(minus)] == minus:
                        idx = i0; placed = True; break
                if not placed:
                    print(f"[apply_patch] hunk not found in {path}; aborting", file=sys.stderr)
                    return False
            else:
                # minus empty and plus empty: nothing to do
                continue
        # Replace
        lines[idx:idx+len(minus)] = plus
    content = "\n".join(lines) + ("\n" if (lines and not lines[-1].endswith("\n")) else "")
    if DRY_RUN:
        dbg(f"[dry-run] would update {path}")
        return True
    backup(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return True

ok = True
for op in ops:
    kind = op["op"]
    if kind == "add":
        dbg("ADD", op["path"])
        ok = write_file(op["path"], op.get("content", "")) and ok
    elif kind == "update":
        dbg("UPDATE", op["path"])
        ok = apply_update(op["path"], op.get("hunks", [])) and ok
    elif kind == "delete":
        p = op["path"]
        dbg("DELETE", p)
        if DRY_RUN:
            dbg(f"[dry-run] would delete {p}")
        else:
            if os.path.exists(p):
                backup(p)
                os.remove(p)
        ok = ok and True
    elif kind == "rename":
        src, dst = op["from"], op["to"]
        dbg("RENAME", src, "->", dst)
        if DRY_RUN:
            dbg(f"[dry-run] would rename {src} -> {dst}")
        else:
            if not os.path.exists(src):
                print(f"[apply_patch] rename failed: {src} not found", file=sys.stderr)
                ok = False
            else:
                ensure_dirs(dst)
                backup(dst)  # just in case something exists at dst
                os.rename(src, dst)
        ok = ok and True
    else:
        print(f"[apply_patch] unknown op: {kind}", file=sys.stderr)
        ok = False

sys.exit(0 if ok else 1)
PYCODE

rc=$?
if (( rc != 0 )); then
  echo "[apply_patch] failed (rc=$rc)" >&2
  exit "$rc"
fi

# Best-effort stdin restore for shells that track paused streams.
# This does not harm when stdin wasn't paused.
if [[ -t 0 ]]; then
  # Re-enable raw mode if your host app uses it later; here we just resume.
  { true <&0; } 2>/dev/null || true
fi

if (( VERBOSE )); then
  echo "[apply_patch] success" >&2
fi
