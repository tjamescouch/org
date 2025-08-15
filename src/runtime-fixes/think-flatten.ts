import { C } from "../ui/colors";

/**
 * Coalesces the one-token CoT lines printed immediately after:
 *   "**** <agent> @ <time>:"
 * into a single, readable line. Works even if the header has ANSI colors.
 */
(function installThinkFlattener() {
  if (process.env.SHOW_THINK !== "1") return;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");
  let inThinkBlock = false;
  let buf: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  const resetTimer = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(), 200);
  };

  const isTinyFragment = (s: string) => {
    const t = stripAnsi(s).trim();
    if (!t) return false;
    if (t.startsWith("[DEBUG]") || t.startsWith("[INFO ") || t.startsWith("[WARN ") || t.startsWith("[ERROR]")) return false;
    if (t.startsWith("assistant:") || t.startsWith("user:")) return false;
    // Alnum + light punctuation, up to a few words (typical streamed CoT tokens)
    return /^[A-Za-z0-9'’\-.,:;()]+$/.test(t) && t.split(/\s+/).length <= 3;
  };

  const startBlockIfHeader = (s: string) => {
    const t = stripAnsi(s).trim();
    return /^\*{4}\s+\S+\s+@\s+.+?:\s*$/.test(t);
  };

  const flatten = (parts: string[]) =>
    parts.join(" ").replace(/\s+/g, " ").trim();

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (buf.length === 0) return;
    const line = flatten(buf);
    buf = [];
    if (line) {
      const col = (C.think ?? C.debug ?? "\x1b[38;5;213m"); // fuchsia fallback
      const colored = col + line + (C.reset ?? "\x1b[0m");
      orig.log(colored);
    }
  };

  const wrap = (kind: "log" | "info" | "warn" | "error") => (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      const s = args[0] as string;

      // Detect header line and begin a CoT block
      if (startBlockIfHeader(s)) {
        flush();
        inThinkBlock = true;
        return orig[kind](s);
      }

      // Buffer tiny token lines while in CoT block
      if (inThinkBlock && isTinyFragment(s)) {
        buf.push(stripAnsi(s));
        resetTimer();
        return; // swallow here, emit on flush
      }

      // Any normal line ends the CoT block
      if (inThinkBlock) {
        flush();
        inThinkBlock = false;
      }
    }
    return orig[kind](...args);
  };

  console.log = wrap("log");
  console.info = wrap("info");
  console.warn = wrap("warn");
  console.error = wrap("error");

  process.on("exit", flush);
})();
