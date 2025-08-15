import { C } from "../ui/colors";

/**
 * Coalesces the single-token lines that appear immediately after
 * "**** <agent> @ ..." into a single flattened line (fuchsia/pink),
 * then lets normal content flow.
 */
(function installThinkFlattener() {
  if (process.env.SHOW_THINK !== "1") return;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  let inThinkBlock = false;
  let buf: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  const resetTimer = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(), 250);
  };

  const isTinyFragment = (s: string) => {
    const t = s.trim();
    if (!t) return false;
    // Skip diagnostics and headers.
    if (t.startsWith("[DEBUG]") || t.startsWith("[INFO ") || t.startsWith("[WARN ") || t.startsWith("[ERROR]")) return false;
    if (t.startsWith("assistant:") || t.startsWith("user:")) return false;
    // Very short tokens typical of streamed CoT.
    return /^[A-Za-z0-9'’\-.,:;()]+$/.test(t) && t.length <= 24;
  };

  const flatten = (parts: string[]) =>
    parts.join(" ").replace(/\s+/g, " ").trim();

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (buf.length === 0) return;
    const line = flatten(buf);
    buf = [];
    if (line) {
      const colored = (C.think ?? C.debug ?? "") + line + (C.reset ?? "");
      orig.log(colored);
    }
  };

  const startBlockIfHeader = (s: string) => {
    // Example header: "**** alice @ 2:12:52 AM:"
    return /^\*{4}\s+\S+\s+@\s+.+?:\s*$/.test(s.trim());
  };

  const wrap = (kind: "log" | "info" | "warn" | "error") => (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      const s = args[0] as string;

      // If we see the header, we *begin* a CoT block.
      if (startBlockIfHeader(s)) {
        flush();               // flush any previous block
        inThinkBlock = true;   // begin new block
        return orig[kind](s);  // pass header through
      }

      // While in a CoT block, collect tiny fragments.
      if (inThinkBlock && isTinyFragment(s)) {
        buf.push(s.trim());
        resetTimer();          // coalesce bursts
        return;                // suppress immediate printing
      }

      // Reaching a "normal" line: first flush CoT, then pass through.
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
