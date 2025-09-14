// tests/unit/backend.api-shape.test.ts
import { describe, it, expect } from "bun:test";

describe("podman backend API shape", () => {
  it.skip("exports PodmanSession and sandboxImageTag", async () => {
    const mod = await import("../../src/sandbox/backends/podman");
    expect(typeof mod.PodmanSession).toBe("function");
    expect(typeof mod.sandboxImageTag).toBe("function");
  });
});
