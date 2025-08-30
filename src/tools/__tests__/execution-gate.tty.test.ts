// tests/execution-gate.test.ts
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { ExecutionGate } from "../../tools/execution-gate";


// Mock out external dependencies
import * as promptLineModule from "../../../src/utils/prompt-line";
import * as ttyModule from "../../../src/input/tty-controller";
import type { ExecutionGuard } from "../../../src/tools/execution-guards";

describe("ExecutionGate", () => {
  let promptLineMock: ReturnType<typeof mock>;
  let withCookedTTYMock: ReturnType<typeof mock>;

  beforeEach(() => {
    // Reset mocks before every test
    promptLineMock = mock(async (_q: string) => "y");
    withCookedTTYMock = mock(async (fn: () => Promise<void>) => fn());

    (promptLineModule as any).promptLine = promptLineMock;
    (ttyModule as any).withCookedTTY = withCookedTTYMock;

    // Reset to defaults before each test
    ExecutionGate.configure({ safe: false, interactive: true });
  });

  it("should allow execution when safe=false regardless of interactive", async () => {
    ExecutionGate.configure({ safe: false, interactive: false });
    await expect(ExecutionGate.gate("echo ok")).resolves.toBeUndefined();
    expect(promptLineMock).not.toHaveBeenCalled();
  });

  it("should throw if safe=true and interactive=false", () => {
    expect(() =>
      ExecutionGate.configure({ safe: true, interactive: false })
    ).toThrow(/SAFE mode requires interactive/);
  });

  it("should prompt the user when safe=true and interactive=true", async () => {
    ExecutionGate.configure({ safe: true, interactive: true });
    promptLineMock.mockResolvedValueOnce("y");
    await expect(ExecutionGate.gate("ls")).resolves.toBeUndefined();
    expect(promptLineMock).toHaveBeenCalledWith("Run: ls? [y/N] ");
  });

  it("should throw if user denies prompt", async () => {
    ExecutionGate.configure({ safe: true, interactive: true });
    promptLineMock.mockResolvedValueOnce("n");
    await expect(ExecutionGate.gate("rm -rf /")).rejects.toThrow(/User denied/);
  });

  it("should pass guard chain if all allow", async () => {
    const guard: ExecutionGuard = { allow: mock(() => true) };
    ExecutionGate.configure({ safe: false, interactive: true, guards: [guard] });
    await expect(ExecutionGate.gate("ls")).resolves.toBeUndefined();
    expect((guard.allow as any)).toHaveBeenCalledWith("ls");
  });

  it("should block if any guard denies", async () => {
    const guard: ExecutionGuard = { allow: mock(() => false) };
    ExecutionGate.configure({ safe: false, interactive: true, guards: [guard] });
    await expect(ExecutionGate.gate("rm -rf /")).rejects.toThrow(/Execution blocked by guard/);
  });

  it("allow() should return true if gate passes", async () => {
    ExecutionGate.configure({ safe: false, interactive: true });
    const result = await ExecutionGate.allow("echo ok");
    expect(result).toBe(true);
  });

  it("allow() should return false if gate throws", async () => {
    const guard: ExecutionGuard = { allow: mock(() => false) };
    ExecutionGate.configure({ safe: false, interactive: true, guards: [guard] });
    const result = await ExecutionGate.allow("blocked");
    expect(result).toBe(false);
  });

  it("should treat 'yes' (case-insensitive) as confirmation", async () => {
    ExecutionGate.configure({ safe: true, interactive: true });
    promptLineMock.mockResolvedValueOnce("Yes");
    await expect(ExecutionGate.gate("ls")).resolves.toBeUndefined();

    promptLineMock.mockResolvedValueOnce("  y  ");
    await expect(ExecutionGate.gate("ls")).resolves.toBeUndefined();
  });

  it("should reject anything except explicit yes/y", async () => {
    ExecutionGate.configure({ safe: true, interactive: true });
    promptLineMock.mockResolvedValueOnce("nope");
    await expect(ExecutionGate.gate("ls")).rejects.toThrow(/User denied/);
  });
});
