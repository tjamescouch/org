// test/_helpers/fake-agent.ts
import type { ChatMessage } from "../../src/types";
import type { Responder, ChatResponse } from "../../src/scheduler/types";

/**
 * LookupAgent: a deterministic fake implementing Responder.
 *
 * Give it a map of -> response(s). Keys match on the *last* user/assistant
 * message content (trimmed). Values can be a single string or array of strings.
 * Each response is returned as one ChatResponse with toolsUsed=1 by default
 * so the scheduler will spend budget and make progress across hops.
 *
 * Special tags in the response content (e.g. "@@user", "@@group", "@@alice")
 * are intentionally preserved — the real router will parse them.
 */
export class LookupAgent implements Responder {
  public readonly id: string;
  private readonly table: Record<string, string | string[]>;
  private readonly defaultToolsUsed: number;

  // Introspection for tests
  public calls: Array<{
    budget: number;
    peers: string[];
    inbox: ChatMessage[];
  }> = [];

  constructor(
    id: string,
    table: Record<string, string | string[]>,
    opts?: { toolsUsed?: number },
  ) {
    this.id = id;
    this.table = { ...table };
    this.defaultToolsUsed = Math.max(0, opts?.toolsUsed ?? 1);
  }

  async respond(
    messagesIn: ChatMessage[],
    toolBudget: number,
    peers: string[],
    _isDraining: () => boolean,
  ): Promise<ChatResponse[]> {
    this.calls.push({ budget: toolBudget, peers: [...peers], inbox: [...messagesIn] });

    const last = (messagesIn[messagesIn.length - 1]?.content ?? "").trim();
    const programmed = this.table[last] ?? this.table["*"];
    if (!programmed) {
      // No opinion; stay silent.
      return [];
    }

    const responses = Array.isArray(programmed) ? programmed : [programmed];

    return responses.map((content) => ({
      toolsUsed: this.defaultToolsUsed,
      message: {
        role: "assistant",
        from: this.id,
        content,
      },
    }));
  }
}
