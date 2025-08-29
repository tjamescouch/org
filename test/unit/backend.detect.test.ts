// tests/unit/backend.detect.test.ts
import { describe, it, expect } from "bun:test";
import { detectBackend } from "../../src/sandbox/detect";

describe("backend detection", () => {
  it("prefers explicit ORG_BACKEND", () => {
    const old = process.env.ORG_BACKEND;
    process.env.ORG_BACKEND = "podman";
    expect(detectBackend()).toBe("podman");
    process.env.ORG_BACKEND = "docker";
    expect(detectBackend()).toBe("docker");
    process.env.ORG_BACKEND = "mock";
    expect(detectBackend()).toBe("mock");
    if (old === undefined) delete process.env.ORG_BACKEND;
    else process.env.ORG_BACKEND = old;
  });

  it("falls back to engine probing (no env)", () => {
    const old = process.env.ORG_BACKEND;
    delete process.env.ORG_BACKEND;
    // We can't reliably assert podman/docker on all CI hosts, but we can assert it doesn't throw
    const b = detectBackend();
    expect(["podman", "docker", "mock"]).toContain(b);
    if (old) process.env.ORG_BACKEND = old;
  });
});
