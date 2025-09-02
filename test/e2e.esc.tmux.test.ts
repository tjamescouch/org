// test/e2e.esc.tmux.test.ts
// E2E: Pressing ESC during streaming shows immediate ACK, then the app exits gracefully.
// tmux + local SSE server. No external LLM is contacted.

import { describe, test, expect } from "bun:test";

type Cleanup = () => void | Promise<void>;

async function withCleanups<T>(
  fn: (register: (c: Cleanup) => void) => Promise<T>
): Promise<T> {
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
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
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

      // 1) Local SSE mock server (OpenAI-compatible)
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

      // 2) Start an app in a dedicated tmux session.
      // We *inject* the env into the one-shot shell-command so it is guaranteed to be present
      // even if the tmux server's environment is sparse.
      const session = `e2e_esc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

      const envPairs: Array<[string, string]> = [
        // Point to our mock server (cover both our app’s OPENAI and any internal ORG_* variants)
        ["OPENAI_BASE_URL", baseUrl],
        ["ORG_OPENAI_BASE_URL", baseUrl],
        ["LLM_BASE_URL", baseUrl],
        ["ORG_LLM_BASE_URL", baseUrl],
        // inert API key so any "auth" checks pass
        ["OPENAI_API_KEY", "e2e-dummy"],
        ["ORG_OPENAI_API_KEY", "e2e-dummy"],
        // keep everything local: do not try any container engine
        ["SANDBOX_BACKEND", "none"],
        ["ORG_BACKEND", "none"],
        // make terminal predictable
        ["TERM", "xterm-256color"],
        // a few niceties to reduce surprises
        ["NO_COLOR", "1"],
        ["FORCE_COLOR", "0"],
      ];

      // Build: env KEY=VAL ... bun ./src/app.ts --agents alice:openai
      const cmd = [
        "tmux", "new-session", "-d", "-s", session,
        "env",
        ...envPairs.flatMap(([k, v]) => [`${k}=${v}`]),
        "bun", "./src/app.ts", "--agents", "alice:openai",
      ];

      {
        const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
        const status = await p.exited;
        if (status !== 0) {
          const err = await new Response(p.stderr!).text();
          throw new Error(`tmux new-session failed: ${status}\n${err}`);
        }
      }
      register(async () => {
        await Bun.spawn(["tmux", "kill-session", "-t", session]).exited.catch(() => {});
      });

      // tmux helpers
      async function capturePane(): Promise<string> {
        const cp = Bun.spawn(["tmux", "capture-pane", "-p", "-t", session], { stdout: "pipe", stderr: "pipe" });
        const code = await cp.exited;
        const out = await new Response(cp.stdout!).text();
        if (code !== 0) {
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
      })(), 9000, "ready");

      // Send "hi" + Enter
      await sendKeys("h", "i", "Enter");

      // 4) Wait until streaming actually starts (look for any early tokens from mock)
      await withDeadline((async () => {
        for (let i = 0; i < 120; i++) {
          const buf = await capturePane();
          if (/alice\s*\.\.\./i.test(buf) || /The user says/i.test(buf)) return;
          await sleep(100);
        }
        throw new Error("stream did not start");
      })(), 12000, "stream start");

      // 5) Press ESC during stream
      await sendKeys("C-[" /* ESC */);

      // 6) Verify immediate ACK printed (hyphen/en-dash tolerant)
      await withDeadline((async () => {
        for (let i = 0; i < 120; i++) {
          const buf = await capturePane();
          if (/ESC pressed\s*[—–-]\s*finishing current step/i.test(buf) ||
              (/ESC pressed/i.test(buf) && /opening patch review/i.test(buf))) {
            return;
          }
          await sleep(100);
        }
        throw new Error("ESC ACK did not appear");
      })(), 7000, "esc ack");

      // 7) Graceful completion
      await withDeadline((async () => {
        for (let i = 0; i < 150; i++) {
          const alive = await sessionAlive();
          if (!alive) return; // session gone => app exited

          const buf = await capturePane();
          if (/No patch produced\./i.test(buf)) return;
          if (/Patch ready:/i.test(buf) || /Apply this patch\?/i.test(buf)) return;

          await sleep(150);
        }
        throw new Error("app did not reach graceful end condition");
      })(), 30000, "graceful completion");
    });
  }, 45_000);
});
