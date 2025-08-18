#!/usr/bin/env bun
/**
 * runner.ts — single-responsibility shim:
 *  1) Force the process working directory to where the user typed `org`
 *  2) Then import the real app entrypoint.
 *
 * This avoids touching every fs/spawn call in your codebase.
 */

import { pathToFileURL } from "node:url";
import * as fs from "node:fs";

// 1) Switch the process working directory *before* loading the app.
const callerCwd = process.env.ORG_CALLER_CWD || process.env.PWD || process.cwd();
try {
  process.chdir(callerCwd);
} catch (e) {
  console.error(`org: failed to chdir to ${callerCwd}:`, e);
  process.exit(1);
}

// Optionally keep repo tools in PATH (useful if agents shell out)
const appdir = process.env.ORG_APPDIR || "";
if (appdir) {
  process.env.PATH = `${appdir}:${appdir}/scripts:${process.env.PATH ?? ""}`;
}

// 2) Import the real app from the repo by absolute path
const entry = process.env.ORG_ENTRY || "";
if (!entry || !fs.existsSync(entry)) {
  console.error(`org: entrypoint not found at ${entry}`);
  process.exit(66);
}

await import(pathToFileURL(entry).href);

