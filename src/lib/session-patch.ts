import fs from "node:fs";
import path from "node:path";

/** Return absolute path to last-session.patch if found, else null. */
export function findLastSessionPatch(cwd: string): string | null {
  const sessionDir = process.env.ORG_SESSION_DIR
    ? path.resolve(process.env.ORG_SESSION_DIR)
    : path.join(cwd, ".org");

  const p1 = path.join(sessionDir, "last-session.patch");
  if (fs.existsSync(p1)) return p1;

  const appdir = process.env.ORG_APPDIR || process.env.APPDIR || "";
  if (appdir) {
    const p2 = path.join(appdir, ".org", "last-session.patch");
    if (fs.existsSync(p2)) return p2;
  }
  return null;
}
