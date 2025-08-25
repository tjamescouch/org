// tests/policy.write.test.ts
import { describe, it, expect } from "bun:test";

// Adjust imports to your files:
import { matchAny } from "../src/sandbox/glob";
import { defaultPolicy } from "../src/sandbox/policy";

function isAllowed(path: string, allow: string[], deny: string[]) {
  if (deny?.length && matchAny(deny, path)) return false;
  return matchAny(allow ?? [], path);
}

describe("write policy", () => {
  it("deny wins over allow", () => {
    const allow = ["*", "**/*"];
    const deny = [".git/**", "**/*.pem"];

    expect(isAllowed("foo.txt", allow, deny)).toBe(true);
    expect(isAllowed(".git/config", allow, deny)).toBe(false);
    expect(isAllowed("certs/key.pem", allow, deny)).toBe(false);
  });

  it("default policy allows root-level file writes", () => {
    const p = defaultPolicy({ projectDir: "/tmp/x", runRoot: "/tmp/x/.org" });
    // top-level file
    expect(isAllowed("hello.txt", p.write.allow, p.write.deny)).toBe(true);
    // nested file
    expect(isAllowed("test/hello.txt", p.write.allow, p.write.deny)).toBe(true);
    // denied defaults
    expect(isAllowed(".git/config", p.write.allow, p.write.deny)).toBe(false);
    expect(isAllowed(".env", p.write.allow, p.write.deny)).toBe(false);
  });
});
