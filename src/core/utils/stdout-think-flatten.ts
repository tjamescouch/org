import fs from "fs";
import path from "path";
import { flattenThink } from "./think";

/**
 * Intercepts process.stdout.write so that when SHOW_THINK=1 we:
 *  - buffer the CoT block (streamed a line at a time) and
 *  - emit it once, flattened (single line)
 * If DEBUG_COT=1 we also dump raw bytes of every write to logs/cot-bytes-*.log
 */
export function installStdoutThinkFlatten(): void {
  const g: any = globalThis as any;
  if (g.__think_flatten_installed) return;
  g.__think_flatten_installed = true;

  const enableFlatten = process.env.SHOW_THINK === "1";
  const enableBytes   = process.env.DEBUG_COT === "1";

  // lazy open byte-log
  let byteLog: fs.WriteStream | null = null;
  const openByteLog = () => {
    if (!enableBytes) return null;
    if (!byteLog) {
      fs.mkdirSync("logs", { recursive: true });
      const p = path.join("logs", `cot-bytes-${Date.now()}.log`);
      byteLog = fs.createWriteStream(p, { flags: "a" });
      byteLog.write(`# raw stdout bytes (${new Date().toISOString()})\n`);
    }
    return byteLog;
  };

  const originalWrite = process.stdout.write.bind(process.stdout);

  // States for holding a think block between start/end
  let holding = false;
  let holdBuf = "";

  const startMarker = /^(\*\*\*\* .+? @ .+?:)\s*$/m;   // "**** alice @ 3:01:00 AM:"
  const isThinkNoise = (s: string) => startMarker.test(s);

  const flushHold = () => {
    if (!holding) return "";
    holding = false;
    const out = flattenThink(holdBuf); // collapse internal newlines/spaces
    holdBuf = "";
    return out;
  };

  const writeOut = (s: string) => originalWrite(s);

  // Replacement writer
  (process.stdout as any).write = ((chunk: any, enc?: any, cb?: any) => {
    // ---- logging of raw bytes
    if (enableBytes) {
      const log = openByteLog();
      if (log) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc as BufferEncoding | undefined);
        log.write(`\n-- chunk @ ${new Date().toISOString()}\n`);
        log.write(`HEX: ${buf.toString("hex")}\n`);
        log.write(`UTF8_ESCAPED: ${JSON.stringify(buf.toString("utf8"))}\n`);
        log.write(`CODEPOINTS: ${Array.from(buf.values()).map(n=>n.toString(16).padStart(2,"0")).join(" ")}\n`);
      }
    }

    let text = Buffer.isBuffer(chunk) ? chunk.toString(enc as BufferEncoding | undefined) : String(chunk);

    if (!enableFlatten) {
      return originalWrite(chunk, enc, cb);
    }

    // If we see a think "header" line, start holding subsequent output
    if (isThinkNoise(text)) {
      holding = true;
      holdBuf = text;       // include the header line; flattener will keep it once
      return true;          // swallow for now
    }

    // While holding, accumulate until we see a boundary where normal output resumes.
    if (holding) {
      // Heuristic: stop holding when we see a line that begins with '[' (our DEBUG lines)
      // or a role label like "assistant:" or "user:" etc.
      const boundary = /^\[(?:DEBUG|INFO|WARN|ERROR)\]|\b(?:assistant|user|system):/m.test(text);
      if (boundary) {
        const flushed = flushHold();
        writeOut(flushed);    // emit flattened CoT
        return originalWrite(text, enc, cb);
      } else {
        holdBuf += text;
        return true;          // swallow while holding
      }
    }

    return originalWrite(text, enc, cb);
  }) as any;

  // Best-effort cleanup on exit
  process.on("exit", () => {
    if (holding) {
      const flushed = flushHold();
      if (flushed) writeOut(flushed);
    }
    if (byteLog) byteLog.end();
  });
}
