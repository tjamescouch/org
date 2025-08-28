// tests/glob.matchAny.test.ts
import { describe, it, expect } from "bun:test";

// Adjust import path to wherever your helpers live:
import { globToRegExp, matchAny } from "../../src/sandbox/glob";

describe("globToRegExp + matchAny", () => {
  it("`**/*` matches nested but NOT top-level; `*` matches top-level", () => {
    const nestedOnly = ["**/*"];
    const topAndNested = ["*", "**/*"];

    expect(matchAny(nestedOnly, "foo.txt")).toBe(false);
    expect(matchAny(nestedOnly, "dir/foo.txt")).toBe(true);

    expect(matchAny(topAndNested, "foo.txt")).toBe(true);
    expect(matchAny(topAndNested, "dir/foo.txt")).toBe(true);
  });

  it("trailing `/**` treats a directory path as the dir itself OR deeper", () => {
    const pat = ["src/**"];

    // Directory itself should pass
    expect(matchAny(pat, "src")).toBe(true);
    expect(matchAny(pat, "src/")).toBe(true);

    // Any deeper should also pass
    expect(matchAny(pat, "src/main.ts")).toBe(true);
    expect(matchAny(pat, "src/deeper/nested.ts")).toBe(true);

    // Sibling should not
    expect(matchAny(pat, "srcx/main.ts")).toBe(false);
  });

  it("dot-files need to be explicitly allowed; deny patterns override", () => {
    const allow = ["*", "**/*"];
    const deny = [".env", ".git/**", "**/*.pem"];

    // dot-files
    expect(matchAny(allow, ".env")).toBe(true);                   // allowed by "*"
    // but deny wins
    expect(matchAny(deny, ".env")).toBe(true);                    // matches deny
    // .git internals
    expect(matchAny(allow, ".git/config")).toBe(true);            // allowed by "**/*"
    expect(matchAny(deny, ".git/config")).toBe(true);             // denied by ".git/**"

    // A pem file
    expect(matchAny(allow, "secrets/cert.pem")).toBe(true);
    expect(matchAny(deny, "secrets/cert.pem")).toBe(true);        // denied by suffix rule
  });

  it("classic globs", () => {
    expect(globToRegExp("README.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/README.md")).toBe(false); // top-level only

    expect(globToRegExp("**/*.md").test("docs/README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("README.md")).toBe(false);   // nested only
  });
});
