const Reset = "\u001b[0m";
const Dim = "\u001b[2m";
const FgCyan = "\u001b[36m";
const FgGreen = "\u001b[32m";
const FgMagenta = "\u001b[35m";
const FgYellow = "\u001b[33m";
const FgBlue = "\u001b[34m";

function writeRaw(s: string) {
  const anyGlobal: any = globalThis as any;
  const bun = anyGlobal?.Bun;
  if (bun?.stdout?.write) { bun.stdout.write(s); return; }
  anyGlobal?.process?.stdout?.write?.(s);
}

export const Colors = { Reset, Dim, FgCyan, FgGreen, FgMagenta, FgYellow, FgBlue };

export class Logger {
  static info(...a: any[]) { console.log(...a); }
  static warn(...a: any[]) { console.warn(...a); }
  static error(...a: any[]) { console.error(...a); }
  static debug(...a: any[]) { if ((process.env.LOG_LEVEL||'').toUpperCase()==='DEBUG') console.log(...a); }

  /** stream without newline */
  static streamInfo(s: string) { writeRaw(s); }
  static endStreamLine(suffix = "") { writeRaw(suffix + "\n"); }
}

