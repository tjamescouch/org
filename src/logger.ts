// src/logger.ts
import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import { R } from "./runtime/runtime";

type LevelName = "silent" | "error" | "warn" | "info" | "debug" | "trace";
const LEVELS: Record<LevelName, number> = {
  silent: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10,
};

const Reset = "\u001b[0m";
const Dim = "\u001b[2m";
const FgCyan = "\u001b[36m";
const FgGreen = "\u001b[32m";
const FgMagenta = "\u001b[35m";
const FgYellow = "\u001b[33m";
const FgBlue = "\u001b[34m";

export const C = {
  reset: "\x1b[0m",
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,   // <-- fixed here
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  white: (s: string) => `\x1b[37m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

function fromEnvLevel(v: string | undefined, fallback: LevelName): LevelName {
  if (!v) return fallback;
  const s = v.toLowerCase() as LevelName;
  return s in LEVELS ? s : fallback;
}

function ts(): string {
  const d = new Date();
  // 2025-08-27T16-12-05.123Z
  return d.toISOString().replace(/[:]/g, "-");
}

export class Logger {
  private static _level: LevelName = "info";
  private static _stream: fs.WriteStream | null = null;
  private static _filePath: string | null = null;

  static configure(opts: { file?: string; level?: LevelName | string } = {}) {
    if (opts.level) this._level = fromEnvLevel(
      typeof opts.level === "string" ? opts.level : (opts.level as LevelName),
      this._level
    );

    if (opts.file && opts.file !== this._filePath) {
      if (this._stream) {
        try { this._stream.end(); } catch {}
      }
      const dir = path.dirname(opts.file);
      fs.mkdirSync(dir, { recursive: true });
      this._stream = fs.createWriteStream(opts.file, { flags: "a" });
      this._filePath = opts.file;
      this._writeLine("info", `Logger started (pid=${process.pid}) → ${opts.file}`);
    }
  }

  static attachProcessHandlers() {
    process.on("uncaughtException", (err) => {
      this._writeLine("error", `uncaughtException: ${err && (err.stack || err)}`);
      try { this._stream?.end(); } catch {}
    });
    process.on("unhandledRejection", (reason) => {
      this._writeLine("error", `unhandledRejection: ${reason}`);
    });
    process.on("beforeExit", (code) => {
      this._writeLine("info", `beforeExit code=${code}`);
    });
  }

  static level(): LevelName { return this._level; }
  static file(): string | null { return this._filePath; }

  // ---- public logging API
  static trace(...a: any[]) { this._log("trace", a); }
  static debug(...a: any[]) { this._log("debug", a); }
  static info (...a: any[]) { this._log("info",  a); }
  static streamInfo (...a: any[]) { this._stream("info", a); }
  static warn (...a: any[]) { this._log("warn",  a); }
  static error(...a: any[]) { this._log("error", a); }

  // ---- internals
  private static _enabled(level: LevelName): boolean {
    return LEVELS[level] >= LEVELS[this._level];
  }
  private static _log(level: LevelName, args: any[]) {
    if (!this._enabled(level)) return;
    const line = util.formatWithOptions({ colors: false }, ...args);
    this._writeLine(level, line);
  }
  private static _writeLine(level: LevelName, line: string) {
    const pfx = `${ts()} [${level.toUpperCase()}]`;
    const text = `${pfx} ${line}`;
    // Console
    if (level === "error")       console.error(text);
    else if (level === "warn")   console.warn (text);
    else                         console.log  (text);
    // File
    try {
      if (this._stream) {
        this._stream.write(text + "\n");
      }
    } catch { /* ignore */ }
  }
  private static _stream(level: LevelName, chunk: string) {
    if (level === "error")       this.stream.write(chunk);
    else if (level === "warn")   this.stream.write(chunk);
    else                         this.stream.write(chunk);
  }
}
