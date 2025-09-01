// test/e2e.esc.tmux.test.ts
// E2E: Pressing ESC during streaming shows immediate ACK, then the app exits gracefully.
// Robust against the tmux server auto-exiting when the app completes quickly.
//
// Pattern to clone for future interactive e2e tests.

import { describe, test, expect } from "bun:test";

type Cleanup = () => void | Promise<void>;

async function withCleanups<T>(fn: (register: (c: Cleanup) => void) => Promise<T>): Promise<T> {
  const cleanups: Cleanup[] = [];
  const register = (c: Cleanup) => cleanups.unshift(c);
  try {
    return await fn(register);
  } finally {
    for (const c of cleanups) {
      try { await c(); } catch { /* ignore */ }
    }
  }
}

function withDeadline<T>(p: Promise<T>, ms: number, label = "deadline"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function sseChunk(delta: string, idx = 0) {
  const payload = {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "e2e-fake-model",
    choices: [{ index: idx, delta: { content: delta } }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("E2E interactive ESC (tmux + SSE server)", () => {
  test("ESC during streaming shows ACK and completes gracefully", async () => {
    await withCleanups(async (register) => {
      // 1) SSE mock server
      const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                const chunks = [
                  sseChunk("alice ... "),
                  sseChunk('The user says "hi". '),
                  sseChunk("We should greet them. "),
                  sseChunk("@@user Hello! "),
                  sseChunk("How can I help you today? "),
                ];
                let i = 0;
                const tick = () => {
                  if (i < chunks.length) {
                    controller.enqueue(encoder.encode(chunks[i++]!));
                    setTimeout(tick, 120);
                  } else {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                  }
                };
                tick();
              }
            });
            return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
          }
          return new Response("Not found", { status: 404 });
        },
      });
      register(async () => { try { server.stop(true); } catch {} });
      const baseUrl = `http://127.0.0.1:${server.port}`;

      // 2) Tmux session running the app
      const session = `e2e_esc_${Date.now()}_${Math.floor(Math.random()*1e6)}`;

      // NB: We keep env scoping inside tmux shell only.
      const runCmd =
        `export OPENAI_BASE_URL='${baseUrl}' ORG_OPENAI_BASE_URL='${baseUrl}' ORG_LLM_BASE_URL='${baseUrl}'; ` +
        `export OPENAI_MODEL='e2e-fake-model' ORG_OPENAI_MODEL='e2e-fake-model'; ` +
        `export TERM='xterm-256color'; ` +
        // don't 'exec' so we can still print a prompt after exit if needed
        `bun ./src/app.ts --agents alice:lmstudio`;

      {
        const p = Bun.spawn(["tmux", "new-session", "-d", "-s", session, "bash", "-lc", runCmd], { stdout: "pipe", stderr: "pipe" });
        const status = await p.exited;
        if (status !== 0) {
          const err = await new Response(p.stderr!).text();
          throw new Error(`tmux new-session failed: ${status}\n${err}`);
        }
      }
      register(async () => { await Bun.spawn(["tmux", "kill-session", "-t", session]).exited.catch(() => {}); });

      // tmux helpers
      async function capturePane(): Promise<string> {
        const cp = Bun.spawn(["tmux", "capture-pane", "-p", "-t", session], { stdout: "pipe", stderr: "pipe" });
        const code = await cp.exited;
        const out = await new Response(cp.stdout!).text();
        if (code !== 0) {
          // If the session is gone, tmux prints e.g. "no server running ..."
          const err = await new Response(cp.stderr!).text();
          return `${out}\n${err}`.trim();
        }
        return out;
      }

      async function sendKeys(...keys: string[]) {
        const p = Bun.spawn(["tmux", "send-keys", "-t", session, ...keys], { stdout: "pipe", stderr: "pipe" });
        const code = await p.exited;
        if (code !== 0) throw new Error(`tmux send-keys failed (${code})`);
      }

      async function sessionAlive(): Promise<boolean> {
        const p = Bun.spawn(["tmux", "has-session", "-t", session], { stdout: "pipe", stderr: "pipe" });
        const code = await p.exited;
        return code === 0;
      }

      // 3) Wait for readiness banner
      await withDeadline((async () => {
        for (let i = 0; i < 80; i++) {
          const buf = await capturePane();
          if (/Press Esc to gracefully exit/i.test(buf)) return;
          await sleep(100);
        }
        throw new Error("app did not reach ready banner");
      })(), 9000, "app ready");

      // Send "hi" + Enter
      await sendKeys("h", "i", "Enter");

      // 4) Wait until streaming actually starts (robust markers)
      await withDeadline((async () => {
        for (let i = 0; i < 120; i++) {
          const buf = await capturePane();
          if (/alice\s*\.\.\./i.test(buf) || /The user says/i.test(buf)) return;
          await sleep(100);
        }
        throw new Error("stream did not start");
      })(), 12000, "stream start");

      // 5) Press ESC during stream
      await sendKeys("C-["); // ESC

      // 6) Verify immediate ACK printed (stderr/feedback)
      await withDeadline((async () => {
        for (let i = 0; i < 120; i++) {
          const buf = await capturePane();
          // hyphen vs en-dash vs em-dash tolerant
          if (/ESC pressed\s*[—–-]\s*finishing current step/i.test(buf) ||
              /ESC pressed/i.test(buf) && /opening patch review/i.test(buf)) return;
          await sleep(100);
        }
        throw new Error("ESC ACK did not appear");
      })(), 7000, "esc ack");

      // 7) Graceful completion:
      //    Either:
      //      a) we see a known “end” line, or
      //      b) the tmux session ends (which means the app exited and tmux server likely shut down)
      await withDeadline((async () => {
        for (let i = 0; i < 150; i++) {
          const alive = await sessionAlive();
          if (!alive) return; // session gone = app exited cleanly

          const buf = await capturePane();
          if (/No patch produced\./i.test(buf)) return;
          if (/Patch ready:/i.test(buf) || /Apply this patch\?/i.test(buf)) return;

          await sleep(150);
        }
        throw new Error("app did not reach graceful end condition");
      })(), 30000, "graceful completion");
    });
  }, 45000);
});
