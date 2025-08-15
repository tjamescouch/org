import { globalTurnMutex, shouldSerialize } from "../core/turn-mutex";
import { installStdoutBytesTap } from "../core/utils/stdout-bytes-tap";
import { installStdoutThinkFlatten } from "../core/utils/stdout-think-flatten";
if (shouldSerialize) {
  try { console.log("[INFO ] round-robin serializer: SERIALIZE_CHAT=1 (one LLM call at a time)"); } catch {}
}
if (process.env.DEBUG_COT === "1") { try { installStdoutBytesTap(); } catch (e) { console.error("bytes tap failed:", e); } }
installStdoutThinkFlatten(); // SHOW_THINK=1 flattens CoT; DEBUG_COT=1 logs raw bytes
installStdoutThinkFlatten();

import { printBanner } from "../ui/banner";
import { setupKeyInput } from "../ui/key-input";
// main.ts — Interactive (curses) mode by default; script mode with --no-interactive

// Existing app bootstrap follows. We keep this file minimal so the flattener
// is definitely installed before any output begins.

export async function bootstrapApp(argv: string[]) {
  printBanner();
  await setupKeyInput();
  // The actual app entrypoint is in org.ts; we keep this tiny to guarantee
  // stdout hooks are active first.
}
