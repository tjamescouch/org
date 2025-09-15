import { Logger } from "../logger";
import { Responder } from "../scheduler";
import { createPDAStreamFilter } from "../utils/filter-passes/llm-pda-stream";
import { TagPart } from "../utils/tag-parser";
import { TagSplitter } from "../utils/tag-splitter";

type Delivery =
  | { kind: "group"; content: string }
  | { kind: "agent"; to: string; content: string }
  | { kind: "user"; content: string }
  | { kind: "file"; name: string; content: string };

type RouteOutcome = {
  deliveries: Delivery[];
  yieldForUser: boolean;
  yieldForGroup: boolean;
  sawTags: { user: boolean; group: boolean; file: boolean; agent: boolean };
};

/**
 * Parse & route textual content. Also returns yield hints:
 *  - yieldForUser: message contains @@user
 *  - yieldForGroup: message contains @@group
 */
export function routeWithTags(raw: string, agentTokens: string[]): RouteOutcome {
  const filter = createPDAStreamFilter();
  let s = filter.feed(raw) + filter.flush();

  const parts: TagPart[] = TagSplitter.split(s, { agentTokens });
  const deliveries: Delivery[] = [];
  let sawUser = false, sawGroup = false, sawFile = false, sawAgent = false;

  for (const p of parts) {
    if (!p.content?.trim()) continue;
    if (p.kind === "group") {
      deliveries.push({ kind: "group", content: p.content });
      sawGroup = true;
    } else if (p.kind === "user") {
      deliveries.push({ kind: "user", content: p.content });
      sawUser = true;
    } else if (p.kind === "file") {
      deliveries.push({ kind: "file", name: p.tag, content: p.content });
      sawFile = true;
    } else if (p.kind === "agent") {
      deliveries.push({ kind: "agent", to: p.tag, content: p.content });
      sawAgent = true;
    }
  }

  // If no delivery was produced (e.g. empty string), treat as group message
  if (deliveries.length === 0) {
    deliveries.push({ kind: "group", content: "" });
    sawGroup = true;
  }

  return ({
    deliveries,
    yieldForUser: sawUser,
    yieldForGroup: sawGroup,
    sawTags: { user: sawUser, group: sawGroup, file: sawFile, agent: sawAgent },
  });
}

type RouterCallbacks = {
  onGroup?: (from: string, content: string) => Promise<void> | void;
  onAgent?: (from: string, to: string, content: string) => Promise<void> | void;
  onUser?: (from: string, content: string) => Promise<void> | void;
  onFile?: (from: string, name: string, content: string) => Promise<void> | void;
};

/**
 * makeRouter(callbacks) → route(from, text) → RouteOutcome
 * Provides a small adapter that app.ts can call directly.
 */
export function makeRouter(cb: RouterCallbacks, agents: Responder[]) {
  return async (from: string, text: string): Promise<RouteOutcome> => {
    const outcome = routeWithTags(text || "", agents.map(a => a.id));
    for (const d of outcome.deliveries) {
      if (d.kind === "group" && cb.onGroup) {
        await cb.onGroup(from, d.content);
      } else if (d.kind === "agent" && cb.onAgent) {
        await cb.onAgent(from, d.to, d.content);
      } else if (d.kind === "user" && cb.onUser) {
        await cb.onUser(from, d.content);
      } else if (d.kind === "file" && cb.onFile) {
        await cb.onFile(from, d.name, d.content);
      }
    }
    return outcome;
  };
}
