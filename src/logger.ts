// src/logger.ts
// A simple logging utility with configurable log levels.  Logs can be
// controlled at runtime by setting the current level via setLevel().  When
// the current log level is DEBUG all messages are printed; when set to a
// higher severity, debug and info messages will be suppressed.

export enum LogLevel { NONE, ERROR, WARN, INFO, DEBUG }
const colours = {
  [LogLevel.DEBUG]: "\x1b[96m",  // bright cyan (was fuchsia)
  [LogLevel.INFO]:  "\x1b[32m",
  [LogLevel.WARN]:  "\x1b[33m",
  [LogLevel.ERROR]: "\x1b[31m",
};

export class Logger {
  private static level: number = LogLevel.INFO;
  static log(level: LogLevel, msg: string) {
    if (level <= Logger.level) {
      const colour = colours[level] ?? "";
      console.log(`${colour}[${LogLevel[level]}]${msg}\x1b[0m`);
    }
  }
  static debug(msg: string) { Logger.log(LogLevel.DEBUG, msg); }
  static info(msg: string)  { Logger.log(LogLevel.INFO, msg); }
  static warn(msg: string) { Logger.log(LogLevel.WARN, msg); }
  static error(msg: string)  { Logger.log(LogLevel.ERROR, msg); }

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
}

// Allow runtime configuration via environment variable LOG_LEVEL.  If set,
// override the default DEBUG level accordingly.  Accepted values are the
// same as those accepted by setLevel().  Any invalid value is ignored.
(() => {
  const envLevel = process.env.LOG_LEVEL || LogLevel.INFO;
  if (envLevel) {
    Logger.setLevel(envLevel);
  }
})();