import * as fs from "fs";
import * as path from "path";

type Level = "trace" | "debug" | "info" | "warn" | "error";


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
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  white: (s: string) => `\x1b[37m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};
export class Logger {
  // ---- configuration / sinks
  private static _inited = false;
  private static _file: fs.WriteStream | null = null;

  private static _levelOrder: Record<Level, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
  };

  private static _threshold: Level = (process.env.ORG_LOG_LEVEL as Level) ||
    (process.env.LOG_LEVEL as Level) ||
    "info";

  /** Ensure log dir/file exists and open file sink. */
  private static _ensure() {
    if (this._inited) return;
    this._inited = true;

    const appdir =
      process.env.ORG_APPDIR ||
      path.resolve(process.cwd(), ".org"); // fallback if not set
    const logDir =
      process.env.ORG_LOG_DIR ||
      path.join(appdir, "logs");

    const defaultName = `run-${new Date()
      .toISOString()
      .replace(/[:]/g, "-")
      .replace(/\.\d+Z$/, "Z")}.log`;

    const logFile =
      process.env.ORG_LOG_FILE ||
      path.join(logDir, defaultName);

    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {
      // ignore, best-effort
    }

    try {
      this._file = fs.createWriteStream(logFile, { flags: "a" });
      // Small header so we can identify starts in a long file
      const hdr = `==== LOG START ${new Date().toISOString()} pid=${process.pid} ====\n`;
      this._file.write(hdr);
    } catch {
      // If file fails, we still keep console logging
      this._file = null;
    }
  }

  /** Compare level against threshold. */
  private static _should(level: Level): boolean {
    return (
      this._levelOrder[level] >= this._levelOrder[this._threshold]
    );
  }

  /** Best-effort stringify for console/file logs. */
  private static _formatArgs(args: any[]): string {
    return args
      .map((v) => {
        if (v instanceof Error) {
          return v.stack || v.message || String(v);
        }
        if (typeof v === "string") return v;
        if (typeof v === "object" && v !== null) {
          try {
            return JSON.stringify(v);
          } catch {
            return String(v);
          }
        }
        return String(v);
      })
      .join(" ");
  }

  /** Write a line to console + file. */
  private static _writeLine(level: Level, line: string) {
    // Console
    if (level === "warn" || level === "error") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
    // File
    try {
      this._file?.write(line);
    } catch {
      // ignore; console is still useful
    }
  }

  /** Core line-logging (prefixed, newline-terminated). */
  private static _log(level: Level, args: any[]) {
    this._ensure();
    if (!this._should(level)) return;
    const ts = new Date().toISOString();
    const msg = this._formatArgs(args);
    const line = `[${ts}] ${level.toUpperCase()} ${msg}\n`;
    this._writeLine(level, line);
  }

  // ---- public logging API
  static trace(...a: any[]) { this._log("trace", a); }
  static debug(...a: any[]) { this._log("debug", a); }
  static info (...a: any[]) { this._log("info",  a); }
  static warn (...a: any[]) { this._log("warn",  a); }
  static error(...a: any[]) { this._log("error", a); }

  /**
   * streamInfo: write raw chunks (no timestamp/prefix/newline)
   * to stdout and the log file. Useful for token-by-token streaming.
   * Call with "\n" at the end to ensure a newline when you’re done.
   */
  static streamInfo(...a: any[]) {
    this._ensure();
    if (!this._should("info")) return;

    // Preserve raw strings/buffers; stringify everything else
    const raw = a
      .map((v) => {
        if (typeof v === "string" || Buffer.isBuffer(v)) return v as any;
        return this._formatArgs([v]);
      })
      .join("");

    // Console (stdout)
    process.stdout.write(raw);

    // File
    try {
      this._file?.write(raw);
    } catch {
      // ignore file errors
    }
  }

  /** Optional: close the log file on shutdown (usually not needed). */
  static close() {
    try { this._file?.end(); } catch {}
    this._file = null;
    this._inited = false;
  }
}
