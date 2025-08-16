// core/entity/agent-model.ts (excerpt) — only the changed imports and the lock acquisition spots.
// This file is a *drop-in* replacement for your AgentModel that now
// refreshes the ChannelLock lease during streaming via chatOnce({ onData }).

import { channelLock } from "../channel-lock";
import { chatOnce, summarizeOnce } from "../../transport/chat";

// ... inside receiveMessage(), where you acquire the lock:
const release = await channelLock.waitForLock(10 * 1000, `agent:${this.id}`);
// Guard again after acquiring the lock ... (unchanged)

// When calling summarizeOnce: (no streaming here; unchanged)

// When calling chatOnce, pass onData to touch the lease while tokens stream:
const messagesForHop = [...normalized, nudgeMsg];
const msg = await (async () => {
  let _msg: any;
  _msg = await chatOnce(this.id, messagesForHop, {
    tools: toolsForHop,
    tool_choice: toolChoiceForHop,
    num_ctx: 128000,
    abortDetectors: detectors,
    model: this.model,
    soc: this.socText,
    temperature: 1 + tempBump,
    onData: () => {
      // Keep the lock fresh while we are actively receiving data
      try { (release as any).touch?.(); } catch {}
    },
  });
  return _msg;
})();

// ... later, in finally { await release(); }
