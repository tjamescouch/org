import { test, expect } from "bun:test";
import { AgentModel } from "../src/core/entity/agent-model";

test("_viewForSelf maps roles & prefixes correctly", () => {
  const alice: any = new AgentModel("alice", "mock");

  const out = alice["_viewForSelf"]([
    { role: "user", from: "User",  content: "hi" } as any,
    { role: "user", from: "alice", content: "I am me" } as any,
    { role: "user", from: "bob",   content: "hello" } as any,
    { role: "user", from: "carol", content: "[carol] already tagged" } as any,
    { role: "tool", from: "sh",    content: "ok" } as any,
    { role: "system", from: "System", content: "n" } as any,
  ]);

  expect(out[0].role).toBe("user");
  expect(out[1].role).toBe("assistant");                    // self -> assistant
  expect(out[2].role).toBe("user");                         // others -> user
  expect(String(out[2].content).startsWith("[bob] ")).toBe(true);
  expect(out[3].content).toBe("[carol] already tagged");    // no double-prefix
  expect(out[4].role).toBe("tool");
  expect(out[5].role).toBe("system");
});
