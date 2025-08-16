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
