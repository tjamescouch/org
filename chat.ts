import { TextDecoder } from "util";

const BASE_URL = "http://192.168.56.1:11434"; // host-only IP
const MODEL = "gpt-oss:120b";

// ---- Types (OpenAI-style) ----
export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  from: string;
  role: ChatRole;
  content: string;
  name?: string;           // for tool messages
  tool_call_id?: string;   // for tool messages
  reasoning?: string;
  recipient?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: any; // JSON Schema
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface AssistantMessage {
  role: "assistant";
  content?: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
}

interface ChatCompletionResp {
  choices: { message: AssistantMessage }[];
}

const formatMessage = (message: ChatMessage): any => {
  return {
    ...message,
    content: `${message.from}: ${message.content}`
  };
}


export async function chatOnce(
  name: string,
  messages: ChatMessage[],
  opts?: {
    tools?: ToolDef[];
    tool_choice?: "auto" | { type: "function"; function: { name: string } };
    temperature?: number;
    model?: string;
    baseUrl?: string;
  }
): Promise<AssistantMessage> {
  const url = `${opts?.baseUrl ?? BASE_URL}/v1/chat/completions`;

  const body = {
    model: opts?.model ?? MODEL,
    messages: messages.map(formatMessage),
    tools: opts?.tools,
    tool_choice: opts?.tool_choice ?? (opts?.tools ? "auto" : undefined),
    temperature: opts?.temperature ?? 0,
    stream: true,                          // <-- key change
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10*60*1000)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    const content = `HTTP ${resp.status} – ${resp.statusText}\n${txt}`;
    console.error(content);
    return { role: "assistant", content }; // degraded msg
  }

  /* -----------------------------------------------------------
     Parse the SSE / chunked response:
     Each chunk is a line:  data: { ...delta... }\n
     Last line:            data: [DONE]
  ------------------------------------------------------------ */
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder("utf-8");

  let contentBuf = "";
  let thinkingBuf = "";
  let toolCalls: ToolCall[] | undefined;
  let done = false;
  let namePrinted = false;
  let firstThink = true;
  let firstNotThink = true;
  let firstTool = true;
  

  while (!done) {
    const { value, done: streamDone } = await reader.read();

    if (streamDone) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const lineRaw of chunk.split("\n")) {
      const line = lineRaw.trim();
      if (!line.startsWith("data:")) continue;

      if(!namePrinted) {
        console.log(`\n\nX ${name}:`);
        namePrinted = true;
      }

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        break;
      }

      try {
        const parsed = JSON.parse(payload) as {
          choices: { delta: any; }[];
        };
        const delta = parsed.choices?.[0]?.delta ?? {};

        if (delta.reasoning) {
          if(firstThink) {
            firstThink = false;
            console.log("<think>");
          }
          Bun.stdout.write(delta.reasoning);
        } else if (delta.content) { 
          if(firstNotThink && !firstThink) {
            firstNotThink = false;
            console.log("\n</think>\n");
          }
        } else {
          if(firstNotThink && !firstThink) {
            firstNotThink = false;
            console.log("\n</think>\n");
          }
        }

        Bun.stdout.write(delta.content);

        if (delta.content) contentBuf += delta.content;
        if (delta.reasoning) thinkingBuf += delta.reasoning;
        if (delta.tool_calls) toolCalls = delta.tool_calls as ToolCall[];
      } catch (e) {
        console.warn("⚠️  Bad chunk:", e);
      }
    }

  }

  return {
    role: "assistant",
    content: contentBuf.trim(),
    reasoning: thinkingBuf,
    tool_calls: toolCalls,
  };
}
