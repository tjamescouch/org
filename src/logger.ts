/**
 * Simple logger with configurable log levels.  Use Logger.debug(),
 * Logger.info(), Logger.warn() and Logger.error() to emit log
 * messages.  The minimum level can be set via the LOG_LEVEL
 * environment variable (DEBUG, INFO, WARN, ERROR, or NONE).  If no
 * variable is specified, DEBUG is used by default.
 */

export enum LogLevel {
  NONE  = 0,
  ERROR = 1,
  WARN  = 2,
  INFO  = 3,
  DEBUG = 4,
}

// Convert a string like "DEBUG" into a LogLevel.  Defaults to
// DEBUG when the input is unrecognised.
function parseLevel(value: string | undefined): LogLevel {
  if (!value) return LogLevel.DEBUG;
  const upper = value.toUpperCase();
  switch (upper) {
    case 'NONE':  return LogLevel.NONE;
    case 'ERROR': return LogLevel.ERROR;
    case 'WARN':  return LogLevel.WARN;
    case 'INFO':  return LogLevel.INFO;
    case 'DEBUG': return LogLevel.DEBUG;
    default:      return LogLevel.DEBUG;
  }
}

export class Logger {
  /**
   * The minimum severity level at which log messages will be emitted.
   */
  static level: LogLevel = parseLevel(process.env.LOG_LEVEL as string);

  private static emit(prefix: string, level: LogLevel, args: any[]): void {
    if (Logger.level < level) return;
    // Use console.error to ensure logs appear on stderr consistently
    console.error(prefix, ...args);
  }

  static debug(...args: any[]): void { Logger.emit('[DEBUG]', LogLevel.DEBUG, args); }
  static info(...args: any[]): void { Logger.emit('[INFO]',  LogLevel.INFO,  args); }
  static warn(...args: any[]): void { Logger.emit('[WARN]',  LogLevel.WARN,  args); }
  static error(...args: any[]): void { Logger.emit('[ERROR]', LogLevel.ERROR, args); }
}