// src/logger.ts
/* eslint-disable no-console */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as util from "util";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

function parseLevel(x: string | undefined, fallback: LogLevel): LogLevel {
  const s = String(x || "").toLowerCase().trim();
  if (s in LEVEL_RANK) return s as LogLevel;
  // Node-style DEBUG=1 / DEBUG=true bumps level to "debug"
  if (s === "1" || s === "true" || s === "yes") return "debug";
  return fallback;
}

function nowTs(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-` +
    `${pad(d.getMonth() + 1)}-` +
    `${pad(d.getDate())} ` +
    `${pad(d.getHours())}:` +
    `${pad(d.getMinutes())}:` +
    `${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

function inspect(value: unknown) {
  if (typeof value === "string") return value;
  return util.inspect(value, { colors: false, depth: 8, maxArrayLength: 100 });
}

function joinArgs(args: any[]): string {
  if (args.length === 1 && typeof args[0] === "string") return args[0];
  return args.map(inspect).join(" ");
}

/** ANSI colors (C = "color") */
export enum C {
  reset = "\x1b[0m",
  bold = "\x1b[1m",
  dim = "\x1b[2m",

  fgGray = "\x1b[90m",
  fgRed = "\x1b[31m",
  fgGreen = "\x1b[32m",
  fgYellow = "\x1b[33m",
  fgBlue = "\x1b[34m",
  fgMagenta = "\x1b[35m",
  fgCyan = "\x1b[36m",
}

type FileSinkConfig = {
  /**
   * When true, write logs to a file under {appDir}/logs.
   * Default: true (to help post-mortem triage)
   */
  enabled?: boolean;

  /**
   * Directory that contains `.org` — we store logs under {dir}/logs.
   * Default: process.env.ORG_APPDIR or "<cwd>/.org"
   */
  appDir?: string;

  /**
   * File name to write inside {appDir}/logs.
   * Default: "org-YYYYMMDD.log"
   */
  filename?: string;

  /**
   * If true, also keep a "latest.log" pointing at the current file.
   * Default: true
   */
  symlinkLatest?: boolean;
};

export type LoggerConfig = {
  /** Minimum level to print & persist (default picks from env) */
  level?: LogLevel;

  /** Force-disable ANSI colors (default uses TTY detection) */
  noColor?: boolean;

  /** Write warnings/errors to stderr (default true) */
  splitStdStreams?: boolean;

  /** Configure file streaming (default enabled) */
  file?: FileSinkConfig;
};

export class Logger {
  // ---- public logging API (kept intact)
  static trace(...a: any[]) { this._log("trace", a); }
  static debug(...a: any[]) { this._log("debug", a); }
  static info (...a: any[]) { this._log("info",  a); }

  /**
   * Streaming info: write *as-is* (no timestamp/level prefix) to stdout
   * and to the log file, without forcing a newline. Use for token streams.
   * Callers can end lines themselves by passing "\n" or using Logger.info().
   */
  static streamInfo(...a: any[]) {
    const s = joinArgs(a);
    this._writeConsole("info", s, /*stream*/ true);
    this._writeFile(s, /*stream*/ true);
  }

  static warn (...a: any[]) { this._log("warn",  a); }
  static error(...a: any[]) { this._log("error", a); }

  // ---- configuration (new, but non-breaking)
  static configure(cfg: LoggerConfig = {}) {
    if (cfg.level) this._level = cfg.level;
    if (typeof cfg.noColor === "boolean") this._noColor = cfg.noColor;
    if (typeof cfg.splitStdStreams === "boolean") this._splitStd = cfg.splitStdStreams;

    if (cfg.file) {
      const file = cfg.file;
      if (typeof file.enabled === "boolean") this._file.enabled = file.enabled;
      if (file.appDir) this._file.appDir = file.appDir;
      if (file.filename) this._file.filename = file.filename;
      if (typeof file.symlinkLatest === "boolean") this._file.symlinkLatest = file.symlinkLatest;
      // Re-open if already initialized (e.g., app switched appDir)
      this._resetFileSink();
    }
  }

  /** Path of the active log file (if file sink is enabled/initialized). */
  static get logFilePath(): string | null { return this._filePath; }

  /** Current log level */
  static get level(): LogLevel { return this._level; }
  static set level(lvl: LogLevel) { this._level = lvl; }

  /** Ensure file sink is open (noop if disabled or already open). */
  static async ensureFileSink(): Promise<void> {
    if (!this._file.enabled) return;
    if (this._fileStream) return;
    await this._openFileSink();
  }

  // ---- internals

  private static _noColor = !process.stdout.isTTY;
  private static _splitStd = true;

  private static _level: LogLevel = (() => {
    // Priority: ORG_LOG_LEVEL > LOG_LEVEL > DEBUG
    const env = process.env as Record<string, string | undefined>;
    const lvl =
      parseLevel(env.ORG_LOG_LEVEL, parseLevel(env.LOG_LEVEL, parseLevel(env.DEBUG, "info")));
    return lvl;
  })();

  // file sink configuration + state
  private static _file: Required<FileSinkConfig> = {
    enabled: true,
    appDir: process.env.ORG_APPDIR || path.resolve(process.cwd(), ".org"),
    filename: "",            // filled on open
    symlinkLatest: true,
  };

  private static _filePath: string | null = null;
  private static _fileStream: fs.WriteStream | null = null;
  private static _openPromise: Promise<void> | null = null;

  private static _color(level: LogLevel, s: string): string {
    if (this._noColor) return s;
    switch (level) {
      case "trace": return `${C.fgGray}${s}${C.reset}`;
      case "debug": return `${C.fgCyan}${s}${C.reset}`;
      case "info":  return `${C.fgGreen}${s}${C.reset}`;
      case "warn":  return `${C.fgYellow}${s}${C.reset}`;
      case "error": return `${C.fgRed}${s}${C.reset}`;
    }
  }

  private static _prefix(level: LogLevel): string {
    const ts = nowTs();
    const tag = this._color(level, level.padEnd(5));
    // [12:34:56.789] info  —
    return `[${ts}] ${tag} —`;
  }

  private static _writeConsole(level: LogLevel, text: string, stream = false) {
    // stream=false -> add prefix + newline
    if (!stream) {
      const out = `${this._prefix(level)} ${text}\n`;
      if (this._splitStd && (level === "warn" || level === "error")) {
        process.stderr.write(out);
      } else {
        process.stdout.write(out);
      }
    } else {
      if (this._splitStd && (level === "warn" || level === "error")) {
        process.stderr.write(text);
      } else {
        process.stdout.write(text);
      }
    }
  }

  private static async _openFileSink() {
    if (!this._file.enabled) return;
    if (this._fileStream) return;
    if (this._openPromise) return this._openPromise;
    this._openPromise = (async () => {
      try {
        const baseDir = path.resolve(this._file.appDir);
        const logsDir = path.join(baseDir, "logs");
        await fsp.mkdir(logsDir, { recursive: true });

        let file = this._file.filename;
        if (!file) {
          // Default: org-YYYYMMDD.log
          const d = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
          file = `org-${ymd}.log`;
        }
        const filePath = path.join(logsDir, file);

        const stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
        // small header when a process attaches
        stream.write(`\n==== logger attached @ ${nowTs()} pid=${process.pid} ====\n`);

        this._fileStream = stream;
        this._filePath = filePath;

        if (this._file.symlinkLatest) {
          try {
            const latest = path.join(logsDir, "latest.log");
            // best-effort symlink replacement
            await fsp.rm(latest, { force: true });
            await fsp.symlink(path.basename(filePath), latest);
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        // If we can't open the file sink, we fall back to console only.
        this._fileStream = null;
        this._filePath = null;
        this._writeConsole("warn", `logger: could not open file sink: ${inspect(e)}`);
      } finally {
        this._openPromise = null;
      }
    })();
    return this._openPromise;
  }

  private static _resetFileSink() {
    if (this._fileStream) {
      try { this._fileStream.end(`\n==== logger detached @ ${nowTs()} ====\n`); }
      catch { /* ignore */ }
    }
    this._fileStream = null;
    this._filePath = null;
    this._openPromise = null;
  }

  private static async _writeFile(text: string, stream = false) {
    if (!this._file.enabled) return;
    if (!this._fileStream) await this._openFileSink();
    const s = stream ? text : `${text}\n`;
    try {
      this._fileStream?.write(s);
    } catch {
      // swallow file write errors; console path remains the source of truth
    }
  }

  private static _log(level: LogLevel, args: any[]) {
    if (LEVEL_RANK[level] < LEVEL_RANK[this._level]) return;
    const text = joinArgs(args);

    // console
    this._writeConsole(level, text, /*stream*/ false);

    // file (async, best effort)
    const line = `[${nowTs()}] ${level.toUpperCase().padEnd(5)} — ${text}`;
    void this._writeFile(line, /*stream*/ false);
  }
}

// --- default bootstrap:
// respect env at import time; create .org/logs lazily on first write
Logger.configure({
  level: Logger.level, // already parsed from env
  file: {
    enabled: (process.env.ORG_LOG_TO_FILE ?? "1") !== "0", // default on
    appDir: process.env.ORG_APPDIR || path.resolve(process.cwd(), ".org"),
    filename: process.env.ORG_LOG_FILE || "",             // empty -> daily file
    symlinkLatest: (process.env.ORG_LOG_LATEST ?? "1") !== "0",
  },
  noColor: (process.env.NO_COLOR ?? "") !== "" || !process.stdout.isTTY,
  splitStdStreams: true,
});
