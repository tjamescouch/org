// test/helpers/mock_llm_server.ts
// Reusable tiny Bun servers that emulate an OpenAI-like /chat/completions API.

export type MockServer = {
  port: number;
  close(): void;
  getReqs(): number;
  getToolReqs(): number;
};

// ---------- utils ----------

export function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

function jsonResponse(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readBody(req: Request): Promise<any> {
  return req.text().then((t) => {
    if (!t) return {};
    try { return JSON.parse(t); } catch { return {}; }
  });
}

function lastUserMessageText(messages: any[]): string {
  const u = [...messages].reverse().find(m => m?.role === "user");
  const content = u?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

// ---------- payload builders ----------

function buildFirstTwoToolsPayload(textForDerivation: string) {
  // Includes BOTH tool_calls and fenced tool blocks as textual fallback.
  const now = Math.floor(Date.now()/1000);
  const h8 = fnv1a32Hex(textForDerivation);
  const fenced =
    "```tool:sh\n" +
    `echo one=${h8}\n` +
    "```\n" +
    "```tool:sh\n" +
    `echo two=${textForDerivation.length}\n` +
    "```\n";

  return {
    id: "cmpl-mock-tools-1",
    object: "chat.completion",
    created: now,
    model: "mock-llm",
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: fenced,
        tool_calls: [
          { id: "call_one", type: "function",
            function: { name: "sh", arguments: JSON.stringify({ cmd: `echo one=${h8}` }) } },
          { id: "call_two", type: "function",
            function: { name: "sh", arguments: JSON.stringify({ cmd: `echo two=${textForDerivation.length}` }) } },
        ],
      },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 14, total_tokens: 26 },
  };
}

function buildDoneGroupPayload(textForDerivation: string) {
  const now = Math.floor(Date.now()/1000);
  const h8 = fnv1a32Hex(textForDerivation);
  return {
    id: "cmpl-mock-tools-2",
    object: "chat.completion",
    created: now,
    model: "mock-llm",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: `@group done h=${h8}` },
    }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  };
}

function buildSimpleTwoToolsPayload() {
  const now = Math.floor(Date.now()/1000);
  const fenced =
    "```tool:sh\n" +
    "echo one\n" +
    "```\n" +
    "```tool:sh\n" +
    "echo two\n" +
    "```\n";
  return {
    id: "cmpl-simple-1",
    object: "chat.completion",
    created: now,
    model: "mock-llm",
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: fenced,
        tool_calls: [
          { id: "call_one", type: "function", function: { name: "sh", arguments: JSON.stringify({ cmd: "echo one" }) } },
          { id: "call_two", type: "function", function: { name: "sh", arguments: JSON.stringify({ cmd: "echo two" }) } },
        ],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

function buildSimpleDonePayload() {
  const now = Math.floor(Date.now()/1000);
  return {
    id: "cmpl-simple-2",
    object: "chat.completion",
    created: now,
    model: "mock-llm",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "@group done" },
    }],
    usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
  };
}

// ---------- servers ----------

/**
 * Deterministic f-server:
 * - First call (no tool messages): two sh tool_calls derived from the latest user text (hash & length).
 * - After any tool messages: '@group done h=<h8>'.
 * Responds to ANY POST path (no /v1 assumption).
 */
export function startFServer(): MockServer {
  let reqCount = 0;
  let toolReqs = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("ok");
      reqCount++;

      const body = await readBody(req);
      const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
      const hasToolMsgs = msgs.some(m => m?.role === "tool");
      if (hasToolMsgs) toolReqs++;

      const txt = lastUserMessageText(msgs);
      const payload = hasToolMsgs ? buildDoneGroupPayload(txt) : buildFirstTwoToolsPayload(txt);
      return jsonResponse(payload);
    },
  });

  return {
    port: server.port,
    close: () => server.stop(true),
    getReqs: () => reqCount,
    getToolReqs: () => toolReqs,
  };
}

/**
 * Simple stateful server:
 * - First call: two fixed sh tool_calls (echo one/two).
 * - After any tool messages: '@group done'.
 * Responds to ANY POST path (no /v1 assumption).
 */
export function startToolCallsServer(): MockServer {
  let reqCount = 0;
  let toolReqs = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("ok");
      reqCount++;

      const body = await readBody(req);
      const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
      const hasToolMsgs = msgs.some(m => m?.role === "tool");
      if (hasToolMsgs) toolReqs++;

      const payload = hasToolMsgs ? buildSimpleDonePayload() : buildSimpleTwoToolsPayload();
      return jsonResponse(payload);
    },
  });

  return {
    port: server.port,
    close: () => server.stop(true),
    getReqs: () => reqCount,
    getToolReqs: () => toolReqs,
  };
}

/**
 * Install a scoped fetch proxy that redirects any request whose path contains
 * `/chat/completions` to the local Bun server on `targetPort`. Returns a restore
 * function to put the original fetch back.
 *
 * This avoids reliance on env-based base-URL plumbing and guarantees that the
 * mock server is actually exercised by the client stack.
 */

/**
 * Install a scoped fetch proxy that redirects ANY POST to the local mock server,
 * unless it is already targeting the mock's host:port. We preserve method, headers,
 * and forward a cloned body (works for Request and init-body variants).
 *
 * Options:
 *   - verbose: log rewrites for debugging
 */
export function installFetchProxy(targetPort: number, opts?: { verbose?: boolean }): () => void {
  const originalFetch = globalThis.fetch;
  const verbose = !!opts?.verbose;

  async function extractBody(input: RequestInfo, init?: RequestInit): Promise<BodyInit | null | undefined> {
    try {
      if (typeof input === "string" || input instanceof URL) {
        const b = init?.body;
        if (b == null) return undefined;
        // Normalize to text for safety; server only needs JSON-ish structure.
        try { return typeof b === "string" ? b : await (new Response(b as any)).text(); } catch { return b; }
      } else {
        const req = input as Request;
        // clone() lets us read body even if original will also consume it later
        try { return await req.clone().text(); } catch { return undefined; }
      }
    } catch { return undefined; }
  }

  function toURLString(input: RequestInfo): string | null {
    try {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.toString();
      return (input as Request).url ?? null;
    } catch { return null; }
  }

  globalThis.fetch = (async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    let urlStr = toURLString(input);
    try {
      const method = (init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? (input as Request).method : undefined) ?? "GET").toUpperCase();

      // Only intercept POSTs
      if (method === "POST") {
        const url = new URL(urlStr ?? "http://invalid/");
        // Avoid infinite loop: do not proxy to the proxy
        const isAlreadyMock = url.hostname === "127.0.0.1" && (url.port === String(targetPort) || url.port === "");
        if (!isAlreadyMock) {
          // Rewrite to the mock; any path is accepted by our server
          const proxied = `http://127.0.0.1:${targetPort}${url.pathname || "/v1/chat/completions"}`;
          const headers = (init?.headers ?? (typeof input !== "string" && !(input instanceof URL) ? (input as Request).headers : undefined));
          const body = await extractBody(input, init);

          if (verbose) {
            try { console.debug?.(`[fetch-proxy] POST ${urlStr} -> ${proxied}`); } catch {}
          }

          return originalFetch(proxied, {
            method: "POST",
            headers,
            body,
          });
        }
      }
    } catch {
      // fall through
    }
    return originalFetch(input as any, init as any);
  }) as typeof globalThis.fetch;

  return () => { globalThis.fetch = originalFetch; };
}
