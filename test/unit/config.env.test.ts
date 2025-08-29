// tests/unit/config.env.test.ts
import { describe, it, expect } from "bun:test";
import { detectBackend } from "../../src/sandbox/detect";

describe("config env respected", () => {
  it("ORG_ENGINE influences detectBackend", () => {
    const old = process.env.ORG_ENGINE;
    process.env.ORG_ENGINE = "docker";
    const b = detectBackend();
    expect(["docker","podman","mock"]).toContain(b);
    if (old === undefined) delete process.env.ORG_ENGINE;
    else process.env.ORG_ENGINE = old;
  });
});
