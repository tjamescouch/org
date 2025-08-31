// streaming-openai-lmstudio.ts
import { Logger } from "../logger";
import { rateLimiter } from "../utils/rate-limiter";
import { timedFetch } from "../utils/timed-fetch";

import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall } from "./types";

export interface OpenAiDriverConfig {
  baseUrl: string;   // e.g. http://127.0.0.1:11434
  model: string;     // e.g. openai/gpt-oss-20b
  timeoutMs?: number; // default 2h (aligns with non-streaming driver)
}

/**
 * **Cooperative streaming**
 * ------------------------
 * To make hotkey acks (Esc / `i`) show **immediately** while the model streams,
 * we yield to the event loop periodically inside the token-processing loops.
 * This is lightweight and does **not** abort the request; it only gives stdin's
 * keypress handler a chance to run promptly.
 */
function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) =>
    typeof (globalThis as any).setImmediate === "function"
      ? (globalThis as any).setImmediate(resolve)
      : setTimeout(resolve, 0)
  );
}

/** Yield every N stream events/chunks (power of two for a cheap bitmask). */
const YIELD_INTERVAL_MASK = 31; // 32 events/chunks

/**
 * Streaming OpenAI-compatible chat driver for LM Studio / OpenAI-style endpoints.
 * Streams tokens via optional callbacks while returning the final ChatOutput.
 *
 * Extra opts supported (all optional, ignored if unused):
 *   - model?: string
 *   - tools?: any[]
 *   - onToken?(t: string): void
 *   - onReasoningToken?(t: string): void
 *   - onToolCallDelta?(delta: ChatToolCall): void
 *   - signal?: AbortSignal
 */
export function makeStreamingOpenAiLmStudio(cfg: OpenAiDriverConfig): ChatDriver {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/v1/chat/completions`;
  // Keep very generous outer guard, like your non-streaming driver.
  const defaultTimeout = cfg.timeoutMs ?? 2 * 60 * 60 * 1000;

  async function chat(messages: ChatMessage[], opts?: any): Promise<ChatOutput> {
    await rateLimiter.limit("llm-ask", 1);
    Logger.debug("streaming messages out", messages);

    const controller = new AbortController();
    const userSignal: AbortSignal | undefined = opts?.signal;
    const linkAbort = () => controller.abort();
    if (userSignal) {
      if (userSignal.aborted) controller.abort();
      else userSignal.addEventListener("abort", linkAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), defaultTimeout);

    const model = opts?.model ?? cfg.model;
    const tools = Array.isArray(opts?.tools) && opts.tools.length ? opts.tools : undefined;

    const onToken: ((t: string) => void) | undefined = opts?.onToken;
    const onReasoningToken: ((t: string) => void) | undefined = opts?.onReasoningToken;
    const onToolCallDelta: ((t: ChatToolCall) => void) | undefined = opts?.onToolCallDelta;

    const t0 = Date.now();
    const approxChars =
      Array.isArray(messages)
        ? messages.reduce((s, m) => s + String((m as any).content ?? "").length, 0)
        : 0;

    Logger.debug("POST /chat (stream)", {
      model,
      messages: Array.isArray(messages) ? messages.length : 0,
      approxChars,
      tools: tools ? tools.length : 0,
      timeoutMs: defaultTimeout
    });

    // Base payload for OpenAI-compatible streaming
    const payload: any = {
      model,
      messages,
      stream: true
    };
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    try {
      const res = await timedFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
        where: "driver:openai-lmstudio:stream",
        // Inner fetch watchdog (separate from AbortController guard)
        timeoutMs: 2 * 60 * 60 * 1000
      });

      Logger.debug("resp(stream)", { status: res.status, ms: Date.now() - t0 });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LM Studio / OpenAI chat (stream) failed (${res.status}): ${text}`);
      }

      // Some servers may fall back to non-streaming JSON despite stream:true (misconfig, proxy, etc.)
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("text/event-stream")) {
        const data = await res.json().catch(() => ({}));
        const choice = data?.choices?.[0];
        const msg = choice?.message || {};
        const content = typeof msg?.content === "string" ? msg.content : "";
        const toolCalls: ChatToolCall[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
        if (content && onToken) onToken(content);
        return { text: content, reasoning: msg?.reasoning || undefined, toolCalls };
      }

      // SSE streaming path
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      let fullText = "";
      let fullReasoning = "";

      // Accumulate tool call deltas per index (OpenAI streaming format)
      const toolByIndex = new Map<number, ChatToolCall>();

      const pumpEvent = (rawEvent: string) => {
        // Each event is lines separated by \n, typically "data: {...}" or "data: [DONE]"
        const dataLines = rawEvent
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.replace(/^data:\s?/, ""));

        if (!dataLines.length) return;
        const joined = dataLines.join("\n").trim();
        if (!joined || joined === "[DONE]") return;

        let payload: any;
        try {
          payload = JSON.parse(joined);
        } catch {
          return; // ignore malformed
        }

        const delta = payload?.choices?.[0]?.delta;
        if (!delta) return;

        // Content tokens
        if (typeof delta.content === "string" && delta.content.length) {
          fullText += delta.content;
          if (onToken) onToken(delta.content);
        }

        // Reasoning tokens (if surfaced by the server/model)
        if (typeof delta.reasoning === "string" && delta.reasoning.length) {
          fullReasoning += delta.reasoning;
          if (onReasoningToken) onReasoningToken(delta.reasoning);
        }

        // Tool call streaming (OpenAI delta format)
        if (Array.isArray(delta.tool_calls)) {
          for (const item of delta.tool_calls) {
            const idx: number = typeof item?.index === "number" ? item.index : 0;
            const prev = toolByIndex.get(idx) ?? {
              id: "",
              type: "function",
              function: { name: "", arguments: "" }
            };

            const d = item?.delta ?? {};
            if (typeof d.id === "string" && d.id) prev.id = d.id;
            if (typeof d.type === "string" && d.type) (prev as any).type = d.type;

            const f = item?.function ?? {};
            if (typeof f.name === "string" && f.name) prev.function.name += f.name;
            if (typeof f.arguments === "string" && f.arguments) prev.function.arguments += f.arguments;

            toolByIndex.set(idx, prev);
            if (onToolCallDelta) onToolCallDelta(prev);
          }
        }
      };

      // Stream reader: browser/electron (WHATWG) or Node stream fallback
      const body: any = res.body;

      // --- Cooperative yield counter (shared across loops) ---
      let spin = 0;
      const maybeYield = async () => {
        // yield every 32 iterations/events
        if ((++spin & YIELD_INTERVAL_MASK) === 0) await yieldToLoop();
      };

      if (body && typeof body.getReader === "function") {
        // WHATWG ReadableStream
        const reader = body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // Process complete events separated by \n\n
          let sepIdx: number;
          while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
            const rawEvent = buf.slice(0, sepIdx).trim();
            buf = buf.slice(sepIdx + 2);
            if (rawEvent) pumpEvent(rawEvent);
            await maybeYield(); // ← give the loop a turn so keypress acks render
          }

          await maybeYield(); // also yield between large chunks
        }
        // Drain remainder (if any)
        if (buf.trim()) pumpEvent(buf.trim());
      } else if (body && typeof body[Symbol.asyncIterator] === "function") {
        // Node.js Readable (for node-fetch/undici in some setups)
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk as Uint8Array, { stream: true });
          let sepIdx: number;
          while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
            const rawEvent = buf.slice(0, sepIdx).trim();
            buf = buf.slice(sepIdx + 2);
            if (rawEvent) pumpEvent(rawEvent);
            await maybeYield(); // ← keep UI responsive during bursts
          }
          await maybeYield();
        }
        if (buf.trim()) pumpEvent(buf.trim());
      } else {
        // Last-resort fallback: try to read as text (non-streaming)
        const txt = await res.text();
        buf += txt;
        const parts = buf.split("\n\n").map((s) => s.trim());
        for (const part of parts) {
          if (part) pumpEvent(part);
          await maybeYield();
        }
      }

      Logger.debug("toolByIndex.entries()", toolByIndex.entries());
      const toolCalls: ChatToolCall[] = Array.from(toolByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v);

      return { text: fullText, reasoning: fullReasoning || undefined, toolCalls };
    } catch (e: any) {
      if (e?.name === "AbortError") Logger.debug("timeout(stream)", { ms: defaultTimeout });
      throw e;
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", linkAbort);
    }
  }

  return { chat };
}
