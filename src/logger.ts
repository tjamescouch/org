// src/logger.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/* ===========================
 * Colors (unchanged surface)
 * =========================== */

export enum C {
  reset   = "\x1b[0m",
  bold    = "\x1b[1m",
  dim     = "\x1b[2m",
  red     = "\x1b[31m",
  green   = "\x1b[32m",
  yellow  = "\x1b[33m",
  blue    = "\x1b[34m",
  magenta = "\x1b[35m",
  cyan    = "\x1b[36m",
}

function colorize(s: string, ...codes: C[]) {
  if (!codes.length) return s;
  return codes.join("") + s + C.reset;
}

// Keep the familiar helpers:
export const red     = (s: string) => colorize(s, C.red);
export const yellow  = (s: string) => colorize(s, C.yellow);
export const green   = (s: string) => colorize(s, C.green);
export const blue    = (s: string) => colorize(s, C.blue);
export const magenta = (s: string) => colorize(s, C.magenta);
export const cyan    = (s: string) => colorize(s, C.cyan);
export const dim     = (s: string) => colorize(s, C.dim);
export const bold    = (s: string) => colorize(s, C.bold);

/* ===========================
 * Logger (compatible surface)
 * =========================== */

type Level = "trace" | "debug" | "info" | "warn" | "error";
const LEVEL_NUM: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info:  30,
  warn:  40,
  error: 50,
};

const VALID_LEVELS = new Set<Level>(["trace", "debug", "info", "warn", "error"]);

function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function isoForFilename(d = new Date()): string {
  // keep Z, replace colons only (safer for filenames); leave '.' (millis) because we strip when needed
  return d.toISOString().replace(/:/g, "-");
}

function ensureDir(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const fallback = path.join(os.tmpdir(), "org", "logs");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function resolveLogFile(dirInput?: string, fileInput?: string): { dir: string; file: string } {
  const base = process.env.ORG_APPDIR ? path.resolve(process.env.ORG_APPDIR) : process.cwd();
  const defaultDir = path.resolve(base, ".org", "logs");

  const dir = ensureDir((dirInput ?? process.env.ORG_LOG_DIR ?? defaultDir).trim() || defaultDir);

  let file = (fileInput ?? process.env.ORG_LOG_FILE ?? "").trim();
  if (!file) {
    file = path.join(dir, `run-${isoForFilename()}.log`.replace(/\./g, "-"));
  } else if (!path.isAbsolute(file)) {
    file = path.resolve(dir, file);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { dir, file };
}

function resolveLevel(levelInput?: string): Level {
  const raw = (levelInput ?? process.env.ORG_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info")
    .toString()
    .toLowerCase()
    .trim() as Level;
  return VALID_LEVELS.has(raw) ? raw : "info";
}

export class Logger {
  private static _level: Level = "info";
  private static _outfile: string | null = null;
  private static _stream: fs.WriteStream | null = null;
  private static _configured = false;

  /** Optional path getters (handy for debugging) */
  static get filePath(): string | null { return this._outfile; }
  static get dirPath(): string | null {
    return this._outfile ? path.dirname(this._outfile) : null;
  }

  /** Configure logger. Keeps public API unchanged. */
  static configure(opts?: { file?: string; level?: Level | string }) {
    const { dir, file } = resolveLogFile(undefined, opts?.file);
    const lvl = resolveLevel(opts?.level as any);

    // publish normalized env so the rest of the app can read one truthy set
    process.env.ORG_LOG_DIR = dir;
    process.env.ORG_RUN_LOG = file;
    process.env.ORG_LOG_LEVEL = lvl;

    this._level = lvl;
    this._outfile = file;

    // lazily (re)open stream
    try {
      if (this._stream) this._stream.end();
      this._stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
    } catch {
      this._stream = null; // fall back to console only
    }

    this._configured = true;
  }

  /** Wire process-level handlers once. */
  static attachProcessHandlers() {
    if (!(process as any).__org_logger_ph__) {
      (process as any).__org_logger_ph__ = true;

      process.on("uncaughtException", (err) => {
        this._writeLine("error", `uncaughtException: ${err?.stack || err}`);
      });
      process.on("unhandledRejection", (reason: any) => {
        this._writeLine("error", `unhandledRejection: ${reason?.stack || reason}`);
      });
      process.on("beforeExit", (code) => {
        this._writeLine("debug", `beforeExit ${code}`);
        // ensure file is flushed
        this._stream?.write("");
      });
    }
  }

  // ---- public logging API (unchanged) ----
  static trace(...a: any[])      { this._log("trace", a); }
  static debug(...a: any[])      { this._log("debug", a); }
  static info (...a: any[])      { this._log("info",  a); }
  static streamInfo (...a: any[]) { this._streamInfo(a); } // as requested
  static warn (...a: any[])      { this._log("warn",  a); }
  static error(...a: any[])      { this._log("error", a); }

  /* ======================
   * Internal implementation
   * ====================== */

  private static _ensureConfigured() {
    if (this._configured) return;
    // auto-config from env, with safe defaults
    const { dir, file } = resolveLogFile();
    const lvl = resolveLevel();
    process.env.ORG_LOG_DIR = dir;
    process.env.ORG_RUN_LOG = file;
    process.env.ORG_LOG_LEVEL = lvl;
    this._level = lvl;
    this._outfile = file;
    try {
      this._stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
    } catch {
      this._stream = null;
    }
    this._configured = true;
  }

  private static _should(level: Level) {
    return LEVEL_NUM[level] >= LEVEL_NUM[this._level];
  }

  private static _now() {
    return new Date().toISOString();
  }

  /** Normal leveled logs with prefix and color to console; stripped to file. */
  private static _log(level: Level, args: any[]) {
    this._ensureConfigured();
    if (!this._should(level)) return;

    const ts = this._now();
    const label = level.toUpperCase().padEnd(5);

    // Console format (colored)
    const line = [colorize(`[${ts}]`, C.dim), label, ...args];

    switch (level) {
      case "trace":
      case "debug":
        // faint label for debug-ish
        console.log(colorize(label, C.dim), ...line.slice(2));
        break;
      case "info":
        console.log(colorize(label, C.cyan), ...line.slice(2));
        break;
      case "warn":
        console.warn(colorize(label, C.yellow), ...line.slice(2));
        break;
      case "error":
        console.error(colorize(label, C.red), ...line.slice(2));
        break;
    }

    // File format (no ANSI)
    const flat = args.map((v) => (typeof v === "string" ? v : safeStringify(v))).join(" ");
    this._writeLine(level, `[${ts}] ${label} ${flat}`);
  }

  /**
   * streamInfo: write exactly what you pass (no level/prefix),
   * to console and file, immediately. Intended for streaming tokens.
   */
  private static _streamInfo(args: any[]) {
    this._ensureConfigured();
    const raw = args.map((v) => (typeof v === "string" ? v : safeStringify(v))).join("");
    // Console: no prefixes, no newline forced (respect caller)
    process.stdout.write(raw);
    // File: stripped
    if (this._stream) {
      this._stream.write(stripAnsi(raw));
    }
  }

  /** Always append a full line to the file if stream available. */
  private static _writeLine(_level: Level, text: string) {
    if (!this._stream) return;
    try {
      this._stream.write(stripAnsi(text) + "\n");
    } catch {
      /* ignore */
    }
  }
}

function safeStringify(v: any): string {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    try {
      return String(v);
    } catch {
      return "<unprintable>";
    }
  }
}
