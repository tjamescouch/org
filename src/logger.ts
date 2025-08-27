// src/logger.ts
/* eslint-disable no-console */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as util from "util";

/* =========================
 *  Public types / constants
 * ========================= */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** ANSI color helpers (kept for compatibility). */
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

export type LoggerConfig = {
  /** Minimum level to print & persist (default is derived from env). */
  level?: LogLevel;
  /** Force-disable ANSI colors (default uses TTY detection). */
  noColor?: boolean;
  /** Write warn/error to stderr (default true). */
  splitStdStreams?: boolean;
  /** Configure persistent file sink. */
  file?: {
    /** Enable/disable writing to a log file (default true). */
    enabled?: boolean;
    /** Base app dir that contains `.org` (default from env or CWD). */
    appDir?: string;
    /**
     * File name to write into {appDir}/logs.
     * Empty -> daily `org-YYYYMMDD.log`.
     */
    filename?: string;
    /** Maintain a `latest.log` symlink (default true). */
    symlinkLatest?: boolean;
  };
};

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

function parseLevel(x: string | undefined, fallback: LogLevel): LogLevel {
  const s = String(x || "").toLowerCase().trim();
  if ((s as LogLevel) in LEVEL_RANK) return s as LogLevel;
  if (s === "1" || s === "true" || s === "yes") return "debug";
  return fallback;
}

function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function asText(x: unknown) {
  if (typeof x === "string") return x;
  return util.inspect(x, { colors: false, depth: 8, maxArrayLength: 200 });
}

function joinArgs(args: any[]): string {
  if (args.length === 1 && typeof args[0] === "string") return args[0];
  return args.map(asText).join(" ");
}

/* ==============
 *   Logger core
 * ============== */

export class Logger {
  // --- public API (kept intact)
  static trace(...a: any[]) { this._log("trace", a); }
  static debug(...a: any[]) { this._log("debug", a); }
  static info(...a: any[]) { this._log("info", a); }

  /**
   * Streaming-friendly info: prints **exactly** what you pass (no prefix,
   * no newline added) and mirrors to the file sink. Useful for token streams.
   */
  static streamInfo(...a: any[]) {
    const s = joinArgs(a);
    this._writeConsole("info", s, /*stream*/ true);
    void this._writeFile(s, /*stream*/ true);
  }

  static warn(...a: any[]) { this._log("warn", a); }
  static error(...a: any[]) { this._log("error", a); }

  /** Non-breaking runtime configuration hook (kept). */
  static configure(cfg: LoggerConfig = {}) {
    if (cfg.level) this._level = cfg.level;
    if (typeof cfg.noColor === "boolean") this._noColor = cfg.noColor;
    if (typeof cfg.splitStdStreams === "boolean") this._splitStd = cfg.splitStdStreams;

    if (cfg.file) {
      const f = cfg.file;
      if (typeof f.enabled === "boolean") this._file.enabled = f.enabled;
      if (f.appDir) this._file.appDir = f.appDir;
      if (typeof f.filename === "string") this._file.filename = f.filename;
      if (typeof f.symlinkLatest === "boolean") this._file.symlinkLatest = f.symlinkLatest;
      this._reopenFileSink(); // react to changes
    }
  }

  /** Expose the active log file path (or null). */
  static get logFilePath(): string | null { return this._filePath; }

  /** Level getters/setters kept for compatibility. */
  static get level(): LogLevel { return this._level; }
  static set level(v: LogLevel) { this._level = v; }

  /**
   * NEW (to match old app expectations): install process-level handlers
   * for better diagnostics. Safe to call multiple times.
   */
  static attachProcessHandlers() {
    if (this._handlersAttached) return;
    this._handlersAttached = true;

    this._onBeforeExit = (code) => {
      this.debug("[process] beforeExit", code);
      // give the file stream a chance to flush
      this._flushFile("beforeExit");
    };
    this._onUncaughtEx = (err: any) => {
      try {
        this.error("[process] uncaughtException:", err?.stack || err);
      } finally {
        this._flushFile("uncaughtException");
      }
    };
    this._onUnhandledRej = (reason: any, p: Promise<any>) => {
      try {
        this.error("[process] unhandledRejection:", reason?.stack || reason, "at", p);
      } finally {
        this._flushFile("unhandledRejection");
      }
    };
    this._onSigInt = () => {
      this.warn("[process] SIGINT");
      this._flushFile("SIGINT");
    };
    this._onSigTerm = () => {
      this.warn("[process] SIGTERM");
      this._flushFile("SIGTERM");
    };

    process.on("beforeExit", this._onBeforeExit);
    process.on("uncaughtException", this._onUncaughtEx);
    process.on("unhandledRejection", this._onUnhandledRej);
    process.on("SIGINT", this._onSigInt);
    process.on("SIGTERM", this._onSigTerm);
  }

  /** Optional: remove previously attached handlers (handy for tests). */
  static detachProcessHandlers() {
    if (!this._handlersAttached) return;
    this._handlersAttached = false;

    if (this._onBeforeExit) process.off("beforeExit", this._onBeforeExit);
    if (this._onUncaughtEx) process.off("uncaughtException", this._onUncaughtEx);
    if (this._onUnhandledRej) process.off("unhandledRejection", this._onUnhandledRej);
    if (this._onSigInt) process.off("SIGINT", this._onSigInt);
    if (this._onSigTerm) process.off("SIGTERM", this._onSigTerm);

    this._onBeforeExit = undefined;
    this._onUncaughtEx = undefined;
    this._onUnhandledRej = undefined;
    this._onSigInt = undefined;
    this._onSigTerm = undefined;
  }

  // ===========
  // internals
  // ===========

  private static _noColor = !process.stdout.isTTY;
  private static _splitStd = true;

  private static _level: LogLevel = (() => {
    const env = process.env as Record<string, string | undefined>;
    return parseLevel(
      env.ORG_LOG_LEVEL,
      parseLevel(env.LOG_LEVEL, parseLevel(env.DEBUG, "info")),
    );
  })();

  // file sink state
  private static _file: Required<NonNullable<LoggerConfig["file"]>> = {
    enabled: (process.env.ORG_LOG_TO_FILE ?? "1") !== "0",
    appDir: process.env.ORG_APPDIR || path.resolve(process.cwd(), ".org"),
    filename: process.env.ORG_LOG_FILE || "",
    symlinkLatest: (process.env.ORG_LOG_LATEST ?? "1") !== "0",
  };
  private static _filePath: string | null = null;
  private static _fileStream: fs.WriteStream | null = null;
  private static _openPromise: Promise<void> | null = null;

  // process handlers
  private static _handlersAttached = false;
  private static _onBeforeExit?: (code: number) => void;
  private static _onUncaughtEx?: (err: any) => void;
  private static _onUnhandledRej?: (reason: any, p: Promise<any>) => void;
  private static _onSigInt?: () => void;
  private static _onSigTerm?: () => void;

  private static _rankOk(level: LogLevel) {
    return LEVEL_RANK[level] >= LEVEL_RANK[this._level];
  }

  private static _color(level: LogLevel, s: string) {
    if (this._noColor) return s;
    switch (level) {
      case "trace": return `${C.fgGray}${s}${C.reset}`;
      case "debug": return `${C.fgCyan}${s}${C.reset}`;
      case "info": return `${C.fgGreen}${s}${C.reset}`;
      case "warn": return `${C.fgYellow}${s}${C.reset}`;
      case "error": return `${C.fgRed}${s}${C.reset}`;
    }
  }

  private static _prefix(level: LogLevel) {
    const tag = this._color(level, level.padEnd(5));
    return `[${ts()}] ${tag} —`;
  }

  private static _writeConsole(level: LogLevel, body: string, stream = false) {
    if (!stream) {
      const line = `${this._prefix(level)} ${body}\n`;
      if (this._splitStd && (level === "warn" || level === "error")) {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
    } else {
      if (this._splitStd && (level === "warn" || level === "error")) {
        process.stderr.write(body);
      } else {
        process.stdout.write(body);
      }
    }
  }

  private static _announced = false;

  private static async _ensureFileSink() {
    if (!this._file.enabled) return;
    if (this._fileStream) return;
    if (this._openPromise) return this._openPromise;

    this._openPromise = (async () => {
      try {
        const base = path.resolve(this._file.appDir);
        const logs = path.join(base, "logs");
        await fsp.mkdir(logs, { recursive: true });

        let name = this._file.filename;
        if (!name) {
          const d = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
          name = `run-${d.toISOString().replace(/[:]/g, "-")}.log`; // run-YYYY-MM-DDTHH-MM-SS.mmmZ.log
          // daily file fallback would be: name = `org-${ymd}.log`;
        }

        // If someone passes an absolute file name, use it as-is. If it's relative,
        // store it in {appDir}/logs/<name>.
        const filePath = path.isAbsolute(name) ? name :
          name.includes(path.sep) ? path.join(base, name) :
            path.join(logs, name);

        const stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
        stream.write(`\n==== logger attached @ ${ts()} pid=${process.pid} ====\n`);

        this._fileStream = stream;
        this._filePath = filePath;

        // Export absolute run-log path for all other modules to consume.
        process.env.ORG_RUN_LOG = filePath;

        // Keep "latest.log" convenience symlink if enabled.
        if (this._file.symlinkLatest) {
          try {
            const latest = path.join(logs, "latest.log");
            await fsp.rm(latest, { force: true });
            await fsp.symlink(path.basename(filePath), latest);
          } catch { /* ignore */ }
        }

        // Announce once so you see where the run is writing.
        if (!this._announced) {
          this.info(`log file: ${JSON.stringify(filePath)}`);
          this._announced = true;
        }
      } catch (e) {
        this._fileStream = null;
        this._filePath = null;
        this._writeConsole("warn", `logger: could not open file sink: ${asText(e)}`);
      } finally {
        this._openPromise = null;
      }
    })();
    return this._openPromise;
  }

  // Public helper so other code never rebuilds the path.
  static runLogPath(): string | null {
    return this._filePath || process.env.ORG_RUN_LOG || null;
  }

  private static _reopenFileSink() {
    if (this._fileStream) {
      try { this._fileStream.end(`\n==== logger detached @ ${ts()} ====\n`); } catch { }
    }
    this._fileStream = null;
    this._filePath = null;
    this._openPromise = null;
    // will lazily re-open on next write
  }

  private static async _writeFile(body: string, stream = false) {
    if (!this._file.enabled) return;
    await this._ensureFileSink();
    const out = stream ? body : `[${ts()}] ${body}\n`;
    try {
      this._fileStream?.write(out);
    } catch {
      // ignore file write errors (console is the source of truth)
    }
  }

  private static _flushFile(context: string) {
    const s = this._fileStream;
    if (!s) return;
    try { s.write(`\n==== flush @ ${ts()} (${context}) ====\n`); } catch { }
    try { s.emit("drain"); } catch { }
  }

  private static _log(level: LogLevel, args: any[]) {
    if (!this._rankOk(level)) return;
    const body = joinArgs(args);

    // console
    this._writeConsole(level, body, /*stream*/ false);

    // file (no colors, with explicit level)
    const plain = `${level.toUpperCase().padEnd(5)} — ${body}`;
    void this._writeFile(plain, /*stream*/ false);
  }
}

/* ======================
 *  Default bootstrapping
 * ====================== */

Logger.configure({
  level: Logger.level,               // already parsed from env
  noColor: (process.env.NO_COLOR ?? "") !== "" || !process.stdout.isTTY,
  splitStdStreams: true,
  file: {
    enabled: (process.env.ORG_LOG_TO_FILE ?? "1") !== "0",
    appDir: process.env.ORG_APPDIR || path.resolve(process.cwd(), ".org"),
    filename: process.env.ORG_LOG_FILE || "",   // empty -> daily file
    symlinkLatest: (process.env.ORG_LOG_LATEST ?? "1") !== "0",
  },
});

// Many callers expect this to be invoked early.
Logger.attachProcessHandlers();
