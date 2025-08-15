import { C, colorOn } from "./ui/colors";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
const order: Record<LogLevel, number> = { DEBUG:10, INFO:20, WARN:30, ERROR:40 };

export const LOG_LEVELS: LogLevel[] = ["DEBUG","INFO","WARN","ERROR"];

export function getLogLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  return (LOG_LEVELS as readonly string[]).includes(env) ? (env as LogLevel) : "INFO";
}

const want = (lvl: LogLevel) => order[lvl] >= order[getLogLevel()];
const tint = (lvl: LogLevel, s: string) => {
  if (!colorOn()) return s;
  const map: Record<LogLevel,string> = { DEBUG:C.debug, INFO:C.info, WARN:C.warn, ERROR:C.error };
  return `${map[lvl]}${s}${C.reset}`;
};

export class Logger {
  static debug(...a: any[]) { if (want("DEBUG")) console.log(tint("DEBUG","[DEBUG]"), ...a); }
  static info (...a: any[]) { if (want("INFO" )) console.log(tint("INFO" ,"[INFO ]"), ...a); }
  static warn (...a: any[]) { if (want("WARN" )) console.warn(tint("WARN" ,"[WARN ]"), ...a); }
  static error(...a: any[]) { if (want("ERROR")) console.error(tint("ERROR","[ERROR]"), ...a); }
}
