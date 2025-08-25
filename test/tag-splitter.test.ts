// test/tag-splitter.test.ts
import { describe, it, expect } from "bun:test";
import { TagSplitter } from "../src/utils/tag-splitter";

type Opts = Parameters<typeof TagSplitter.split>[1];

const baseOpts: Opts = {
  // explicit, case-insensitive token allowlists
  agentTokens: ["alice", "bob"],
  userTokens: ["user"],
  groupTokens: ["group"],
  fileTokens: ["file"],
  // allow single-sentinel forms too
  allowSingleAt: true,
  allowSingleHash: true,
};

describe("TagSplitter (token-driven)", () => {
  it("treats untagged text as a single @@group part", () => {
    const parts = TagSplitter.split("hello world", baseOpts);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "group",
      tag: "group",
      content: "hello world",
      index: 0,
    });
  });

  it("parses a single @@agent with content when agent is whitelisted", () => {
    const parts = TagSplitter.split("@@alice hi there", baseOpts);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "agent",
      tag: "alice",
      content: "hi there",
      index: 0,
    });
  });

  it("ignores unknown @@agent tokens not in allowlist", () => {
    const s = "@@charlie hello";
    const parts = TagSplitter.split(s, baseOpts);
    // no agent match → entire string is plain text group
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "group",
      tag: "group",
      content: s,
      index: 0,
    });
  });

  it("is case-insensitive for allowed tokens", () => {
    const parts = TagSplitter.split("@@Alice Hi", baseOpts);
    expect(parts[0]).toEqual({
      kind: "agent",
      tag: "Alice", // preserves original case in tag text
      content: "Hi",
      index: 0,
    });
  });

  it("parses multiple agent sections and spans content to next tag", () => {
    const s = "@@david nope (not allowed)\n@@alice here are the docs\n@@bob did you get it?";
    const parts = TagSplitter.split(s, baseOpts);
    expect(parts.map(p => [p.kind, p.tag, p.content, p.index])).toEqual([
      ["group", "group", "@@david nope (not allowed)", 0], // preamble before first allowed tag
      ["agent", "alice", "here are the docs", 1],
      ["agent", "bob", "did you get it?", 2],
    ]);
  });

  it("accepts single-@ mentions for agents on boundaries when enabled", () => {
    const parts = TagSplitter.split("@bob ping", { ...baseOpts, allowSingleAt: true });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "agent",
      tag: "bob",
      content: "ping",
      index: 0,
    });
  });

  it("does not treat single-@ mentions as tags when disabled", () => {
    const parts = TagSplitter.split("@bob ping", { ...baseOpts, allowSingleAt: false });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "group",
      tag: "group",
      content: "@bob ping",
      index: 0,
    });
  });

  it("does not treat emails as @-tags (requires boundary before '@')", () => {
    const s = "email me at a@b.com please";
    const parts = TagSplitter.split(s, baseOpts);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "group",
      tag: "group",
      content: s,
      index: 0,
    });
  });

  it("recognizes @@group and @@user only when tokens are allowed", () => {
    const p1 = TagSplitter.split("@@group everyone here?", baseOpts);
    expect(p1).toHaveLength(1);
    expect(p1[0]).toEqual({
      kind: "group",
      tag: "group",
      content: "everyone here?",
      index: 0,
    });

    const p2 = TagSplitter.split("@@user please confirm", baseOpts);
    expect(p2).toHaveLength(1);
    expect(p2[0]).toEqual({
      kind: "user",
      tag: "user",
      content: "please confirm",
      index: 0,
    });

    // Unknown special keyword should be ignored (falls back to group text)
    const s = "@@everyone wave";
    const p3 = TagSplitter.split(s, baseOpts);
    expect(p3).toHaveLength(1);
    expect(p3[0]).toEqual({
      kind: "group",
      tag: "group",
      content: s,
      index: 0,
    });
  });

  it("parses ##NAME file shorthand and normalizes to relative path", () => {
    const s = "##blob.txt This is an awesome\nfile I made for you.";
    const parts = TagSplitter.split(s, baseOpts);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "file",
      tag: "./blob.txt",
      content: "This is an awesome\nfile I made for you.",
      index: 0,
    });
  });

  it("parses ##file:NAME using fileTokens and normalizes", () => {
    const s = "##file:notes.txt contents";
    const parts = TagSplitter.split(s, baseOpts);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "file",
      tag: "./notes.txt",
      content: "contents",
      index: 0,
    });
  });

  it("accepts single-# forms when enabled, including shorthand path", () => {
    const p1 = TagSplitter.split("#file:log.txt hi", { ...baseOpts, allowSingleHash: true });
    expect(p1).toHaveLength(1);
    expect(p1[0]).toEqual({
      kind: "file",
      tag: "./log.txt",
      content: "hi",
      index: 0,
    });

    const p2 = TagSplitter.split("#src/main.ts code", { ...baseOpts, allowSingleHash: true });
    expect(p2).toHaveLength(1);
    expect(p2[0]).toEqual({
      kind: "file",
      tag: "./src/main.ts",
      content: "code",
      index: 0,
    });
  });

  it("does not accept single-# forms when disabled", () => {
    const s = "#file:log.txt hi";
    const parts = TagSplitter.split(s, { ...baseOpts, allowSingleHash: false });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "group",
      tag: "group",
      content: s,
      index: 0,
    });
  });

  it("adds a preamble before first allowed tag as a @@group part and reindexes", () => {
    const s = "Intro text before tag @@alice hello";
    const parts = TagSplitter.split(s, baseOpts);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      kind: "group",
      tag: "group",
      content: "Intro text before tag",
      index: 0,
    });
    expect(parts[1]).toEqual({
      kind: "agent",
      tag: "alice",
      content: "hello",
      index: 1,
    });
  });

  it("trims leading/trailing whitespace inside each part's content", () => {
    const s = "@@alice   hi there   \n@@bob   ok  ";
    const parts = TagSplitter.split(s, baseOpts);
    expect(parts[0].content).toBe("hi there");
    expect(parts[1].content).toBe("ok");
  });

  it("does not match partial/prefix agent names unless explicitly provided", () => {
    // 'al' is a prefix of 'alice' but not allowed as a token
    const s = "@@al hey";
    const parts = TagSplitter.split(s, baseOpts);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "group",
      tag: "group",
      content: s,
      index: 0,
    });

    // If we allow it explicitly, it should be parsed
    const parts2 = TagSplitter.split(s, { ...baseOpts, agentTokens: ["alice", "al", "bob"] });
    expect(parts2).toHaveLength(1);
    expect(parts2[0]).toEqual({
      kind: "agent",
      tag: "al",
      content: "hey",
      index: 0,
    });
  });
});
