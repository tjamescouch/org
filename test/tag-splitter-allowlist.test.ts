// test/tag-splitter-allowlist.test.ts
import { describe, it, expect } from "bun:test";
import { TagSplitter } from "../src/utils/tag-splitter";

const opts = {
  agentTokens: ["alice", "bob"],
  userTokens: ["user"],
  groupTokens: ["group"],
  fileTokens: ["file"],
  allowSingleAt: true,
  allowSingleHash: true,
};

describe("TagSplitter allowlists", () => {
  it("ignores unknown agents", () => {
    const s = "@@charlie hi";
    const p = TagSplitter.split(s, opts);
    expect(p).toHaveLength(1);
    expect(p[0].content).toBe(s);
  });

  it("accepts single-@ mentions for allowed agents", () => {
    const p = TagSplitter.split("@bob ping", opts);
    expect(p[0]).toMatchObject({ kind: "agent", tag: "bob", content: "ping" });
  });
});
