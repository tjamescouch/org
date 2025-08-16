import http from "http";

export type ServerHandle = {
  url: string;
  port: number;
  close: () => Promise<void>;
  getReqs: () => number;
};

export async function startSimpleLLMServer(): Promise<ServerHandle> {
  let reqs = 0;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
        reqs++;
        let body = "";
        for await (const chunk of req) body += chunk;
        const j = JSON.parse(body || "{}");

        // We decide the phase based on presence of tool result messages from the client.
        const messages: any[] = Array.isArray(j.messages) ? j.messages : [];
        const toolResults = messages.filter(m => m?.role === "tool");

        // Phase 1: no tool results yet -> ask for two sh calls
        if (toolResults.length < 2) {
          const json = {
            id: "cmpl-mock",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: j.model || "mock-model",
            choices: [{
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: null, // content optional when tool_calls present
                tool_calls: [
                  { id: "t1", type: "function",
                    function: { name: "sh", arguments: JSON.stringify({ cmd: "echo one" }) } },
                  { id: "t2", type: "function",
                    function: { name: "sh", arguments: JSON.stringify({ cmd: "echo two" }) } }
                ]
              }
            }]
          };
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(json));
          return;
        }

        // Phase 2: we have at least two tool results -> return final assistant content (no tool_calls)
        const lastUserOrAssistant = [...messages].reverse().find(m => m?.role === "user" || m?.role === "assistant");
        const lastText = (typeof lastUserOrAssistant?.content === "string")
          ? lastUserOrAssistant.content
          : Array.isArray(lastUserOrAssistant?.content)
            ? (lastUserOrAssistant.content.find((p: any) => p?.type === "text")?.text ?? "")
            : "";

        const finalJson = {
          id: "cmpl-mock-final",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: j.model || "mock-model",
          choices: [{
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              // Keep simple text; your agent will send it to @group
              content: [{ type: "text", text: `done(${lastText.length})` }]
            }
          }]
        };
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(finalJson));
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    getReqs: () => reqs,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
  };
}
