import { Logger } from "../logger";
import * as readline from "node:readline";
import * as fs from "node:fs";
import { C, colorOn } from "../ui/colors";

function pulseMsg() {
  return colorOn() ? `${C.debug}[waiting for user input...]${C.reset}` : "[waiting for user input...]";
}

async function waitEnter(prompt: string) {
  const ttyPath = "/dev/tty";
  let input: fs.ReadStream | NodeJS.ReadableStream = process.stdin;
  try { if (fs.existsSync(ttyPath)) input = fs.createReadStream(ttyPath); } catch {}
  const rl = readline.createInterface({ input, output: process.stdout });
  const ms = Math.max(1500, parseInt(process.env.WAIT_PULSE_MS ?? "2000", 10) || 2000);

  console.log(colorOn() ? `${C.info}${prompt}${C.reset}` : prompt);
  const id = setInterval(() => console.log(pulseMsg()), ms);

  await new Promise<void>((resolve) => {
    rl.on("line", () => resolve());
    // Fallback: Enter sometimes arrives as "\r"
    rl.on("close", () => resolve());
  });

  clearInterval(id);
  try { (input as any).close?.(); } catch {}
  rl.close();
}

(async () => {
  if (process.env.SAFE_MODE !== "1") return;

  try {
    const chat = await import("../transport/chat"); // where chatOnce lives
    const orig = (chat as any).chatOnce;
    if (typeof orig !== "function") { Logger.warn("safe-mode: chatOnce not found"); return; }
    if ((chat as any).__safeModeWrapped) return;
    (chat as any).__safeModeWrapped = true;

    (chat as any).chatOnce = async function safeWrapped(...args: any[]) {
      const agent = (args?.[0]?.agent ?? args?.[0]?.name ?? "agent");
      await waitEnter(`(SAFE) Press Enter to let ${agent} talk…  (i/s/q still active)`);
      return await orig.apply(this, args);
    };

    Logger.info("safe-mode: chatOnce is now gated by Enter");
  } catch (e: any) {
    Logger.warn("safe-mode: failed to install:", e?.message ?? e);
  }
})();
