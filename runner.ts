#!/usr/bin/env bun
/**
 * runner.ts — single-responsibility shim:
 *  1) Force the process working directory to where the user typed `org`
 *  2) Then import the real app entrypoint.
 *
 * This avoids touching every fs/spawn call in your codebase.
 */
// ---- DEBUG: prove where we look for last-session.patch ----
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { R } from './src/runtime/runtime';

if ((R.env.DEBUG === "1" || R.env.ORG_DEBUG === "1")) {
  const cwd = R.cwd();
  const sessionDir = R.env.ORG_SESSION_DIR
    ? path.resolve(R.env.ORG_SESSION_DIR)
    : path.join(cwd, ".org");
  const patchPath = path.join(sessionDir, "last-session.patch");
  const exists = fs.existsSync(patchPath);

  // stderr so tests still capture stdout separately
  console.error(`[runner] cwd=${cwd}`);
  console.error(`[runner] sessionDir=${sessionDir}`);
  console.error(`[runner] patchPath=${patchPath}`);
  console.error(`[runner] patchExists=${exists}`);
}


// 1) Switch the process working directory *before* loading the app.
const callerCwd = R.env.ORG_CALLER_CWD || R.env.PWD || R.cwd();
try {
  R.chdir(callerCwd);
} catch (e) {
  console.error(`org: failed to chdir to ${callerCwd}:`, e);
  R.exit(1);
}

// Optionally keep repo tools in PATH (useful if agents shell out)
const appdir = R.env.ORG_APPDIR || "";
if (appdir) {
  R.env.PATH = `${appdir}:${appdir}/scripts:${R.env.PATH ?? ""}`;
}

// 2) Import the real app from the repo by absolute path
const entry = R.env.ORG_ENTRY || "";
if (!entry || !fs.existsSync(entry)) {
  console.error(`org: entrypoint not found at ${entry}`);
  R.exit(66);
}

await import(pathToFileURL(entry).href);

