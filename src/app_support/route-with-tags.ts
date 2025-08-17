import { TagParser, TagPart } from "../utils/tag-parser";

export type Delivery =
  | { kind: "group"; content: string }
  | { kind: "agent"; to: string; content: string }
  | { kind: "user";  content: string }
  | { kind: "file";  name: string; content: string };

export type RouteOutcome = {
  deliveries: Delivery[];
  yieldForUser: boolean;
  yieldForGroup: boolean;
  sawTags: { user: boolean; group: boolean; file: boolean; agent: boolean };
};

/**
 * Parse & route textual content. Also returns yield hints:
 *  - yieldForUser: message contains @user
 *  - yieldForGroup: message contains @group
 */
export function routeWithTags(s: string): RouteOutcome {
  const parts: TagPart[] = TagParser.parse(s);
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

  return {
    deliveries,
    yieldForUser: sawUser,
    yieldForGroup: sawGroup,
    sawTags: { user: sawUser, group: sawGroup, file: sawFile, agent: sawAgent },
  };
}
