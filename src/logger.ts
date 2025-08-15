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
  /**
   * The current log level.  Messages at a severity greater than this level
   * will be suppressed.  By default, INFO messages and above are shown.
   */
  private static level: LogLevel = LogLevel.INFO;

  /**
   * Low-level logging helper.  When the given level is less than or equal
   * to the current logger level, emit the message.  Each line is
   * prefixed with the level name and coloured according to its severity.
   */
  static log(level: LogLevel, msg: string) {
    if (level <= Logger.level) {
      const colour = colours[level] ?? "";
      console.log(`${colour}[${LogLevel[level]}]${msg}\x1b[0m`);
    }
  }

  static debug(msg: string) { Logger.log(LogLevel.DEBUG, msg); }
  static info(msg: string)  { Logger.log(LogLevel.INFO, msg); }
  static warn(msg: string)  { Logger.log(LogLevel.WARN, msg); }
  static error(msg: string) { Logger.log(LogLevel.ERROR, msg); }

  /**
   * Set the logger's current level.  The level may be provided as a
   * LogLevel enum or a case-insensitive string (e.g. 'debug', 'INFO').
   * Unknown strings are ignored.  When called with an enum value, the
   * level is set directly.
   */
  static setLevel(level: LogLevel | string): void {
    if (typeof level === 'string') {
      const normalized = level.toUpperCase();
      switch (normalized) {
        case 'DEBUG':
          Logger.level = LogLevel.DEBUG; break;
        case 'INFO':
          Logger.level = LogLevel.INFO; break;
        case 'WARN':
        case 'WARNING':
          Logger.level = LogLevel.WARN; break;
        case 'ERROR':
          Logger.level = LogLevel.ERROR; break;
        case 'NONE':
          Logger.level = LogLevel.NONE; break;
        default:
          return;
      }
    } else {
      Logger.level = level;
    }
  }
}

// On startup, consult the LOG_LEVEL environment variable.  Accepted
// values are the same as those accepted by setLevel().  If LOG_LEVEL
// is undefined or empty, the default INFO level remains.
(() => {
  const env = process.env.LOG_LEVEL;
  if (env) {
    Logger.setLevel(env);
  }
})();