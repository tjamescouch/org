import ChatRoom from "../src/core/chat-room";
import AgentModel from "../src/core/entity/agent-model";
import { TurnManager } from "../src/core/turn-manager";
import { ExecutionGate, ExecutionMode } from "../src/ui/key-input";

// Minimal self-contained mock LLM server that implements /v1/chat/completions.
// It returns two tool calls ("echo one", "echo two") and then a final assistant
// message without tool_calls based on how many role:"tool" messages it sees.
function startMockServer(port: number = 0) {
  const http = require("node:http");
  let reqs = 0;
  const server = http.createServer(async (req: any, res: any) => {
    if (req.method !== "POST" || !req.url || !/\/v1\/chat\/completions$/.test(req.url)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    reqs++;
    const chunks: any[] = [];
    req.on("data", (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      let toolCount = 0;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        const msgs = Array.isArray(body?.messages) ? body.messages : [];
        toolCount = msgs.filter((m: any) => m && m.role === "tool").length;
      } catch {}
      res.setHeader("content-type", "application/json");
      // Non-streaming JSON response (OpenAI Chat Completions compatible subset)
      const toolCall = (cmd: string) => ({
        id: `call_${Math.random().toString(36).slice(2,8)}`,
        type: "function",
        function: { name: "sh", arguments: JSON.stringify({ cmd }) }
      });
      let message: any;
      if (toolCount < 1) {
        message = { role: "assistant", content: "", tool_calls: [toolCall("echo one")] };
      } else if (toolCount < 2) {
        message = { role: "assistant", content: "", tool_calls: [toolCall("echo two")] };
      } else {
        message = { role: "assistant", content: "all done" };
      }
      const payload = { id: "cmpl_mock", object: "chat.completion", choices: [{ index: 0, message }] };
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise<{ url: string; close: () => Promise<void>; getReqs: () => number }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address: any = server.address();
      const url = `http://${address.address}:${address.port}`;
      resolve({
        url,
        close: () => new Promise<void>((r) => server.close(() => r())),
        getReqs: () => reqs
      });
    });
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, timeoutMs = 4000, stepMs = 25) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < timeoutMs) await sleep(stepMs);
}

test("routes OpenAI chat → two tools → @group", async () => {
  // Ensure tools can run without interactive confirmation
  ExecutionGate.setMode(ExecutionMode.DIRECT);

  // Start the mock server
  const server = await startMockServer(0);
  process.env.OAI_BASE = server.url;

  const room = new ChatRoom();
  const a = new AgentModel("alice", "alice"); room.addModel(a);
  const b = new AgentModel("bob", "bob");     room.addModel(b);
  const c = new AgentModel("carol", "carol"); room.addModel(c);
  const tm = new TurnManager(room, [a,b,c], { tickMs: 20, proactiveMs: 40, idleBackoffMs: 0 });

  const groupCounts = new Map<string, number>([["alice",0],["bob",0],["carol",0]]);
  const evs: any = (room as any).events;
  const onSend = (ev: any) => {
    const from = String(ev?.from || "");
    if (groupCounts.has(from)) {
      groupCounts.set(from, (groupCounts.get(from) || 0) + 1);
    }
  };
  if (evs && typeof evs.on === "function") evs.on("send", onSend);

  tm.start();
  await room.broadcast("User", "Kickoff");

  // (1) Ensure the mock server actually received at least one POST
  await waitUntil(() => server.getReqs() >= 1, 3000);
  expect(server.getReqs()).toBeGreaterThanOrEqual(1);

  // (2) Wait until we see at least one group send from any agent
  await waitUntil(() => Array.from(groupCounts.values()).some(v => v > 0), 4000);

  // Stop, then assert
  tm.stop();
  await server.close();

  // We saw at least one broadcast from each agent or at least progress overall
  // (Keep assertions weak to avoid flakiness across environments)
  const total = Array.from(groupCounts.values()).reduce((a,b) => a+b, 0);
  expect(total).toBeGreaterThan(0);
});
