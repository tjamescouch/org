import { TagParser, ParsedTag } from "../utils/tag-parser";

/**
 * Very small in-memory router the app can use. You can adapt this to your
 * actual message bus / room. The contract is:
 *  - group messages go to every agent except the sender
 *  - direct messages go to a single agent
 *  - file messages are surfaced via onFile (you can persist/write them if you want)
 */
export type DeliverFn = (recipient: string, from: string, content: string) => void;
export type BroadcastFn = (from: string, content: string) => void;
export type FileFn = (from: string, filename: string, content: string) => void;

export interface Router {
  route(from: string, text: string): ParsedTag[];
}

export function makeRouter(
  allAgents: string[],
  sendTo: DeliverFn,
  broadcast: BroadcastFn,
  onFile?: FileFn
): Router {
  const parser = new TagParser();

  function route(from: string, text: string): ParsedTag[] {
    const parts = parser.parse(text);

    // If parsing returned empty, do nothing.
    if (!parts.length) return parts;

    for (const part of parts) {
      switch (part.kind) {
        case "group": {
          for (const name of allAgents) {
            if (name === from) continue;
            broadcast(from, part.content);
          }
          break;
        }
        case "agent": {
          const target = allAgents.find(a => a.toLowerCase() === part.tag.toLowerCase());
          if (target) {
            sendTo(target, from, part.content);
          } else {
            // Unknown target → treat as group
            for (const name of allAgents) {
              if (name === from) continue;
              broadcast(from, part.content);
            }
          }
          break;
        }
        case "file": {
          if (onFile) onFile(from, part.tag, part.content);
          break;
        }
      }
    }
    return parts;
  }

  return { route };
}
