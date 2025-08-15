// src/logger.ts
// A simple logging utility with configurable log levels.  Logs can be
// controlled at runtime by setting the current level via setLevel().  When
// the current log level is DEBUG all messages are printed; when set to a
// higher severity, debug and info messages will be suppressed.

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export class Logger {
  /** Current log level.  Defaults to DEBUG. */
  private static currentLevel: LogLevel = LogLevel.DEBUG;

  /** Set the current log level.  Accepts a LogLevel enum value or a
   * case-insensitive string such as 'debug', 'info', 'warn', 'error',
   * or 'none'.  Invalid strings are ignored. */
  static setLevel(level: LogLevel | string): void {
    if (typeof level === 'string') {
      const normalized = level.toUpperCase();
      switch (normalized) {
        case 'DEBUG':
          Logger.currentLevel = LogLevel.DEBUG; break;
        case 'INFO':
          Logger.currentLevel = LogLevel.INFO; break;
        case 'WARN':
        case 'WARNING':
          Logger.currentLevel = LogLevel.WARN; break;
        case 'ERROR':
          Logger.currentLevel = LogLevel.ERROR; break;
        case 'NONE':
          Logger.currentLevel = LogLevel.NONE; break;
        default:
          // ignore invalid strings
          return;
      }
    } else {
      Logger.currentLevel = level;
    }
  }

  /** Log a debug message.  Accepts any arguments acceptable to console.log. */
  static debug(...args: any[]): void {
    if (Logger.currentLevel <= LogLevel.DEBUG) {
      try {
        // Use console.error to ensure debug output appears in Bun test logs
        console.error(...args);
      } catch {
        // ignore errors
      }
    }
  }

  /** Log an informational message. */
  static info(...args: any[]): void {
    if (Logger.currentLevel <= LogLevel.INFO) {
      try { console.error(...args); } catch {}
    }
  }

  /** Log a warning message. */
  static warn(...args: any[]): void {
    if (Logger.currentLevel <= LogLevel.WARN) {
      try { console.error(...args); } catch {}
    }
  }

  /** Log an error message. */
  static error(...args: any[]): void {
    if (Logger.currentLevel <= LogLevel.ERROR) {
      try { console.error(...args); } catch {}
    }
  }
}

// Allow runtime configuration via environment variable LOG_LEVEL.  If set,
// override the default DEBUG level accordingly.  Accepted values are the
// same as those accepted by setLevel().  Any invalid value is ignored.
(() => {
  const envLevel = process.env.LOG_LEVEL;
  if (envLevel) {
    Logger.setLevel(envLevel);
  }
})();