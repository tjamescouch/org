import { C, colorOn } from "./ui/colors";

type Lvl = "DEBUG"|"INFO"|"WARN"|"ERROR";
const want = (lvl: Lvl) => {
  const env = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  const order: Record<Lvl,number> = { DEBUG:10, INFO:20, WARN:30, ERROR:40 };
  return order[lvl] >= (order[env as Lvl] ?? 20);
};
const tint = (lvl: Lvl, s: string) => {
  if (!colorOn()) return s;
  const map: Record<Lvl,string> = { DEBUG:C.debug, INFO:C.info, WARN:C.warn, ERROR:C.error };
  return `${map[lvl]}${s}${C.reset}`;
};

export class Logger {
  static debug(...a: any[]) { if (want("DEBUG")) console.log(tint("DEBUG","[DEBUG]"), ...a); }
  static info (...a: any[]) { if (want("INFO" )) console.log(tint("INFO" ,"[INFO ]"), ...a); }
  static warn (...a: any[]) { if (want("WARN" )) console.warn(tint("WARN" ,"[WARN ]"), ...a); }
  static error(...a: any[]) { if (want("ERROR")) console.error(tint("ERROR","[ERROR]"), ...a); }
}
