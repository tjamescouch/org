import { Logger } from "../logger";

import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall } from "./types";

export interface OpenAiDriverConfig {
  baseUrl: string; // e.g. http://127.0.0.1:11434
  model: string;   // e.g. openai/gpt-oss-20b
  timeoutMs?: number; // default 45s
}

/**
 * Minimal OpenAI-compatible chat driver for LM Studio / OpenAI-style endpoints.
 * Adds an AbortController timeout so requests can’t hang the app.
 */
export function makeLmStudioOpenAiDriver(cfg: OpenAiDriverConfig): ChatDriver {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/v1/chat/completions`;
  const defaultTimeout = cfg.timeoutMs ?? 145_000;

  async function postChat(messages: ChatMessage[], opts?: { model?: string; tools?: any[] }): Promise<ChatOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), defaultTimeout);

    try {
      const payload: any = {
        model: (opts?.model || cfg.model),
        messages: messages.map(m => {
          const out: any = { role: m.role, content: m.content };
          if (m.role === "tool") {
            if ((m as any).tool_call_id) out.tool_call_id = (m as any).tool_call_id;
            if ((m as any).name) out.name = (m as any).name;
          }
          return out;
        }),
        temperature: 0.7,
      };
      if (opts?.tools && Array.isArray(opts.tools) && opts.tools.length > 0) {
        payload.tools = opts.tools;
        payload.tool_choice = "auto";
      }

      const t0 = Date.now();
      const charSum = messages.reduce((s, m) => s + String((m as any).content ?? "").length, 0);
      Logger.debug("POST /chat", { model: opts?.model ?? cfg.model, msgs: messages.length, chars: charSum, tools: !!opts?.tools && opts.tools.length ? opts.tools.length : 0, timeoutMs: defaultTimeout });

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      Logger.debug("resp", { status: res.status, ms: Date.now() - t0 });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LM Studio / OpenAI chat failed (${res.status}): ${text}`);
      }

      const data: any = await res.json();

      Logger.debug("parsed", { took: Date.now() - t0, hasChoices: !!data?.choices?.length });

      const choice = data?.choices?.[0];
      const msg = choice?.message || {};
      const content = typeof msg?.content === "string" ? msg.content : "";
      const toolCalls: ChatToolCall[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
      return { text: content, reasoning: msg?.reasoning || undefined, toolCalls };
    } catch (e: any) {
      if (e?.name === "AbortError") Logger.debug("timeout", { ms: defaultTimeout });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return { chat: postChat };
}
