
// test/mock-llm.ts
// A tiny deterministic mock "OpenAI" chat server:
//  - 1st POST: returns two tool_calls (sh echo one; sh echo two)
//  - 2nd POST: after any tool result is present in messages, returns final
//              assistant message as a *plain string* with @group
import http from 'http';

export interface StartedMock {
  url: string;
  close: () => Promise<void>;
  getReqs: () => number;
}

export async function startMockLLMServer(): Promise<StartedMock> {
  let reqs = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/v1/chat/completions')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    reqs++;
    let body = '';
    for await (const chunk of req) body += chunk;
    let json: any;
    try { json = JSON.parse(body || '{}'); } catch { json = {}; }

    const messages = Array.isArray(json?.messages) ? json.messages : [];
    const hasToolResult = messages.some((m: any) => m?.role === 'tool');

    let payload: any;

    if (!hasToolResult) {
      // Phase 1: ask runner to use two tools
      payload = {
        id: "cmpl_mock_1",
        object: "chat.completion",
        model: json?.model ?? "mock",
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "sh", arguments: JSON.stringify({ cmd: "echo one" }) } },
              { id: "call_2", type: "function", function: { name: "sh", arguments: JSON.stringify({ cmd: "echo two" }) } },
            ]
          }
        }]
      };
    } else {
      // Phase 2: return a regular assistant content string including @group
      const lastUser = [...messages].reverse().find((m: any) => m?.role === 'user');
      const userText = typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.map((c: any) => c?.text ?? '').join('')
          : '';
      const L = userText.length;

      payload = {
        id: "cmpl_mock_2",
        object: "chat.completion",
        model: json?.model ?? "mock",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            // IMPORTANT: plain string content so downstream treats it as a normal message
            content: `@group done(${L})`
          }
        }]
      };
    }

    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind mock server');
  const url = `http://${addr.address}:${addr.port}`;

  return {
    url,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
    getReqs: () => reqs,
  };
}
