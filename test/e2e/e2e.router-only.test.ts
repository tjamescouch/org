/* test/e2e/e2e.router-only.test.ts
 * Router-only delivery tests. No scheduler assumptions here.
 */

import { describe, it, expect } from "bun:test";
import { makeRouter } from "../../src/routing/route-with-tags";
import { Inbox } from "../../src/scheduler/inbox";
import type { Responder } from "../../src/scheduler/types";

function mk(agents: string[]) {
  const inbox = new Inbox();
  const responders: Responder[] = agents.map(id => ({
    id,
    save: async () => {},
    respond: async () => [],
  } as Responder));

  const router = makeRouter(
    {
      onAgent: async (_from, to, cleaned) => {
        if (cleaned) inbox.push(to, { role: "user", from: "user", content: cleaned });
      },
      onGroup: async (_from, cleaned) => {
        const content = cleaned ?? "";
        for (const id of agents) inbox.push(id, { role: "user", from: "user", content });
      },
      onUser: async () => { /* no enqueue for user on input */ },
      onFile: async () => {},
    },
    responders
  );
  return { inbox, router };
}

describe("router-only delivery", () => {
  it("@@agent routes DM to that agent only", async () => {
    const { inbox, router } = mk(["alice", "bob"]);
    await router("user", "@@alice hello");
    expect(inbox.size("alice")).toBe(1);
    expect(inbox.size("bob")).toBe(0);
  });

  it("@@group. broadcasts to all agents", async () => {
    const { inbox, router } = mk(["alice", "bob", "carol"]);
    await router("user", "@@group. hi all");
    expect(inbox.size("alice")).toBe(1);
    expect(inbox.size("bob")).toBe(1);
    expect(inbox.size("carol")).toBe(1);
  });

  it("@@user is a no-op for input (no agent enqueues)", async () => {
    const { inbox, router } = mk(["alice"]);
    await router("user", "@@user please confirm");
    expect(inbox.size("alice")).toBe(0);
  });
});
