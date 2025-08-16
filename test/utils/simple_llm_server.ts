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
        const msgs = j.messages || [];
        const last = msgs[msgs.length - 1]?.content || "";

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
              content: [{"type":"text","text": `done(${(last||"").length})`}],
              tool_calls: [
                { id: "t1", type: "function",
                  function: { name: "sh", arguments: JSON.stringify({"cmd":"echo one"}) } },
                { id: "t2", type: "function",
                  function: { name: "sh", arguments: JSON.stringify({"cmd":"echo two"}) } }
              ]
            }
          }]
        };

        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(json));
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
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => err ? reject(err) : resolve())
    )
  };
}
