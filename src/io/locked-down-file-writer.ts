import path from "path";
import type { ISandboxSession } from "../sandbox/types";

/**
 * LockedDownFileWriter
 * - Accepts a *relative* path under /work
 * - Writes via sandbox `session.exec(...)` so policy & commit/violation checks apply
 * - Base64 payload, no shell interpolation of content
 * - Enforces size limits & path traversal checks
 */
export class LockedDownFileWriter {
  private readonly maxBytes: number;
  private readonly workRoot = "/work";    // sandbox root

  constructor(private session: ISandboxSession, opts?: { maxBytes?: number }) {
    this.maxBytes = Math.max(1, opts?.maxBytes ?? 1_000_000); // 1 MB default
  }

  async write(relPath: string, content: string): Promise<void> {
    const safeRel = this.asSafeRel(relPath);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxBytes) {
      throw new Error(`refusing to write ${bytes} bytes (> ${this.maxBytes})`);
    }
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const dst = path.posix.join(this.workRoot, safeRel);
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

    const cmd = [
      "set -euo pipefail",
      `dst=${q(dst)}`,
      `mkdir -p "$(dirname "$dst")"`,
      // write atomically: temp + rename
      `tmp="$dst.tmp.$$"`,
      `printf %s ${q(b64)} | base64 -d > "$tmp"`,
      `chmod 0644 "$tmp"`,
      `mv -f "$tmp" "$dst"`,
      // verify roundtrip
      `test -f "$dst"`
    ].join("; ");

    const r = await this.session.exec(cmd);
    if (!r.ok) throw new Error(`sandbox write failed (exit ${r.exit})`);
    // Commit/violation handling is performed by session.exec(...) already.
  }

  /** Normalize to a *relative* POSIX path, reject traversal and absolute paths. */
  private asSafeRel(p: string): string {
    const raw = String(p ?? "").trim();
    if (!raw) throw new Error("empty filename");
    // Strip leading ./ that the tag parser might add
    const noDot = raw.replace(/^\.\/+/, "");
    const norm = path.posix.normalize(noDot);

    // Disallow absolute, parent traversal, and sneaky resets
    if (norm.startsWith("/") || norm.startsWith("../") || norm.includes("/../")) {
      throw new Error(`illegal path outside /work: ${raw}`);
    }
    // Optional: block .org and .git entirely
    if (norm.startsWith(".org/") || norm === ".org" || norm.startsWith(".git/") || norm === ".git") {
      throw new Error(`writes to ${norm} are forbidden`);
    }
    return norm;
  }
}
