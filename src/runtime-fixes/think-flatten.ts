import { C } from "../ui/colors";
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

  const headerRe = /^\*{4}\s+\S+\s+@\s+.+?:\s*$/; // **** alice @ 12:34:56 AM:
  const isHeader = (s: string) => headerRe.test(stripAnsi(s).trim());
  const isTiny = (s: string) => {
    const t = stripAnsi(s).trim();
    if (!t) return false;
    if (/^\[(DEBUG|INFO|WARN|ERROR)\]/.test(t)) return false;
    if (/^(assistant|user):/.test(t)) return false;
    return /^[\p{L}\p{N}’'\-.,:;()]+$/u.test(t) && t.split(/\s+/).length <= 3;
  };
  const flatten = (parts: string[]) => parts.join(" ").replace(/\s+/g, " ").trim();

  const resetTimer = () => { if (flushTimer) clearTimeout(flushTimer); flushTimer = setTimeout(() => flush(), 160); };
  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!buf.length) return;
    const line = flatten(buf); buf = [];
    if (!line) return;
    const f = (C.think ?? "\x1b[38;5;171m"), r = (C.reset ?? "\x1b[0m");
    orig.log(f + line + r);
  };

  const wrap = (k: "log"|"info"|"warn"|"error") => (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      const s = args[0];
      if (isHeader(s)) { flush(); inThink = true; return orig[k](s); }
      if (inThink && isTiny(s)) { buf.push(stripAnsi(s)); resetTimer(); return; }
      if (inThink) { flush(); inThink = false; }
    }
    return orig[k](...args);
  };

  console.log = wrap("log");
  console.info = wrap("info");
  console.warn = wrap("warn");
  console.error = wrap("error");

  process.stdout.write = function (chunk: any, ...args: any[]) {
    try {
      const s = typeof chunk === "string" ? chunk : (chunk?.toString?.() ?? "");
      const lines = s.split(/\r?\n/);
      const emit = (line: string) => orig.write(line + "\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0 && i === lines.length - 1) break;
        if (isHeader(line)) { flush(); inThink = true; emit(line); continue; }
        if (inThink && isTiny(line)) { buf.push(stripAnsi(line)); resetTimer(); continue; }
        if (inThink) { flush(); inThink = false; }
        emit(line);
      }
      return true;
    } catch { return orig.write(chunk, ...args); }
  } as any;

  process.on("exit", flush);
})();
