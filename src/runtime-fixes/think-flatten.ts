import { C } from "../ui/colors";

/**
 * Flattens one-token-per-line CoT into a single line.
 * ANSI-safe (we strip color before header detection) and
 * also intercepts process.stdout.write.
 */
(function installThinkFlattener() {
  if (process.env.SHOW_THINK !== "1") return;

  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    write: process.stdout.write.bind(process.stdout) as (chunk: any, ...args: any[]) => boolean,
  };

  let inThink = false;
  let buf: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  const resetTimer = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(), 180);
  };

  const headerRe = /^\*{4}\s+\S+\s+@\s+.+?:\s*$/; // **** alice @ 12:34:56 AM:
  const isHeader = (s: string) => headerRe.test(stripAnsi(s).trim());

  const isTinyToken = (s: string) => {
    const t = stripAnsi(s).trim();
    if (!t) return false;
    if (/^\[(DEBUG|INFO|WARN|ERROR)\]/.test(t)) return false;
    if (/^(assistant|user):/.test(t)) return false;
    return /^[A-Za-z0-9’'\-.,:;()]+$/.test(t) && t.split(/\s+/).length <= 3;
  };

  const flatten = (parts: string[]) => parts.join(" ").replace(/\s+/g, " ").trim();

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!buf.length) return;
    const line = flatten(buf);
    buf = [];
    if (!line) return;
    const fuchsia = (C.think ?? C.debug ?? "\x1b[38;5;171m");
    orig.log(fuchsia + line + (C.reset ?? "\x1b[0m"));
  };

  const wrapConsole = (kind: "log" | "info" | "warn" | "error") => (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      const s = args[0] as string;
      if (isHeader(s)) { flush(); inThink = true; return orig[kind](s); }
      if (inThink && isTinyToken(s)) { buf.push(stripAnsi(s)); resetTimer(); return; }
      if (inThink) { flush(); inThink = false; }
    }
    return orig[kind](...args);
  };

  console.log = wrapConsole("log");
  console.info = wrapConsole("info");
  console.warn = wrapConsole("warn");
  console.error = wrapConsole("error");

  // Intercept low-level streaming too (some streams use write directly)
  process.stdout.write = function (chunk: any, ...args: any[]) {
    try {
      const s = typeof chunk === "string" ? chunk : (chunk?.toString?.() ?? "");
      const lines = s.split(/\r?\n/);
      if (lines.length === 1) {
        const one = lines[0];
        if (isHeader(one)) { flush(); inThink = true; return orig.write(chunk, ...args); }
        if (inThink && isTinyToken(one)) { buf.push(stripAnsi(one)); resetTimer(); return true; }
        if (inThink) { flush(); inThink = false; }
        return orig.write(chunk, ...args);
      } else {
        // multi-line: handle each line
        let wrote = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.length === 0 && i === lines.length - 1) break;
          if (isHeader(line)) { flush(); inThink = true; orig.write(line + "\n"); wrote = true; continue; }
          if (inThink && isTinyToken(line)) { buf.push(stripAnsi(line)); resetTimer(); continue; }
          if (inThink) { flush(); inThink = false; }
          orig.write(line + "\n"); wrote = true;
        }
        return wrote || true;
      }
    } catch {
      return orig.write(chunk, ...args);
    }
  } as any;

  process.on("exit", flush);
})();
