import { describe, it, expect } from "bun:test";
import { ensureOk } from "../../src/sandbox/sh-result";

describe("ensureOk", () => {
  it("treats undefined code as success", () => {
    const r = ensureOk({ stdout: "ok\n", stderr: "" }, "sh");
    expect(r.stdout).toBe("ok\n");
  });

  it("passes through code === 0", () => {
    const r = ensureOk({ code: 0, stdout: "done" }, "sh");
    expect(r.stdout).toBe("done");
  });

  it("throws with stderr on nonzero code", () => {
    expect(() =>
      ensureOk({ code: 2, stdout: "noise", stderr: "bad args" }, "sh echo")
    ).toThrow(/sh echo failed \(code 2\): bad args/);
  });

  it("falls back to stdout when stderr is empty", () => {
    expect(() =>
      ensureOk({ code: 1, stdout: "permission denied", stderr: "" }, "podman.exec")
    ).toThrow(/podman.exec failed \(code 1\): permission denied/);
  });

  it("uses 'unknown error' when both streams are empty", () => {
    expect(() =>
      ensureOk({ code: 127, stdout: "", stderr: "" }, "sh")
    ).toThrow(/sh failed \(code 127\): unknown error/);
  });
});
