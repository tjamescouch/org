// tests/execution-gate.test.ts
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";


// Mock out external dependencies
import * as promptLineModule from "../../utils/prompt-line";
import * as ttyModule from "../../input/tty-controller";
import type { ExecutionGuard } from "../execution-guards";
import { ExecutionGate } from "../execution-gate";


// Typed handles to mocked exports
type PromptLine = typeof import("../../utils/prompt-line")["promptLine"];
type WithCookedTTY = typeof import("../../input/tty-controller")["withCookedTTY"];
type ExecutionGateClass = typeof import("../execution-gate")["ExecutionGate"];

let promptLineMock: ReturnType<typeof mock<PromptLine>>;
let withCookedTTYMock: ReturnType<typeof mock<WithCookedTTY>>;

async function loadWithMocks() {
  // fresh spies each test
  promptLineMock = mock<PromptLine>(async () => "y");
  withCookedTTYMock = mock<WithCookedTTY>(async (fn) => {
    await fn();
  });

  // Provide fully typed export objects (no casts)
  const promptExports: typeof import("../../utils/prompt-line") = {
    promptLine: promptLineMock,
  };
  const ttyExports: typeof import("../../input/tty-controller") = {
    withCookedTTY: withCookedTTYMock,
  };

  // Install module mocks BEFORE importing the SUT
  mock.module("../src/utils/prompt-line", () => promptExports);
  mock.module("../src/input/tty-controller", () => ttyExports);

  ExecutionGate.configure({ safe: false, interactive: true, guards: [] });
}

beforeEach(async () => {
  mock.restore(); // clear any previous module mocks/spies
  await loadWithMocks();
});

afterEach(() => {
  mock.restore();
});

describe("ExecutionGate.configure", () => {
  it("throws when safe=true and interactive=false", () => {
    expect(() =>
      ExecutionGate.configure({ safe: true, interactive: false })
    ).toThrow(/SAFE mode requires interactive/i);
  });
});

describe("ExecutionGate.gate (non-safe)", () => {
  it("does not prompt or wrap TTY when safe=false", async () => {
    ExecutionGate.configure({ safe: false, interactive: true, guards: [] });
    await expect(ExecutionGate.gate("echo ok")).resolves.toBeUndefined();
    expect(promptLineMock).not.toHaveBeenCalled();
    expect(withCookedTTYMock).not.toHaveBeenCalled();
  });

  it("runs guard chain and blocks when a guard denies", async () => {
    const guard = { allow: mock((hint: string) => hint === "ok") };
    ExecutionGate.configure({ safe: false, interactive: true, guards: [guard] });

    await expect(ExecutionGate.gate("ok")).resolves.toBeUndefined();
    expect(guard.allow).toHaveBeenCalledWith("ok");

    await expect(ExecutionGate.gate("nope")).rejects.toThrow(/Execution blocked by guard/i);
    expect(guard.allow).toHaveBeenCalledWith("nope");
  });
});

describe.skip("ExecutionGate.gate (safe mode)", () => {
  it("prompts via promptLine and wraps in withCookedTTY", async () => {
    ExecutionGate.configure({ safe: true, interactive: true, guards: [] });
    promptLineMock.mockImplementationOnce(async () => "y");

    await expect(ExecutionGate.gate("ls")).resolves.toBeUndefined();

    expect(withCookedTTYMock).toHaveBeenCalledTimes(1);
    expect(promptLineMock).toHaveBeenCalledWith("Run: ls? [y/N] ");
  });

  //just because this is alarming to see on the terminal
  //it("rejects when user does not answer yes", async () => {
  //  ExecutionGate.configure({ safe: true, interactive: true, guards: [] });
  //  promptLineMock.mockImplementationOnce(async () => "n");

  //  await expect(ExecutionGate.gate("rm -rf /")).rejects.toThrow(/User denied/i);
  //});

  it("accepts 'y' and 'yes' (case-insensitive, with whitespace)", async () => {
    ExecutionGate.configure({ safe: true, interactive: true, guards: [] });

    promptLineMock.mockImplementationOnce(async () => "Yes");
    await expect(ExecutionGate.gate("cmd")).resolves.toBeUndefined();

    promptLineMock.mockImplementationOnce(async () => "  y  ");
    await expect(ExecutionGate.gate("cmd")).resolves.toBeUndefined();
  });
});

describe("ExecutionGate.allow", () => {
  it("returns true when gate passes", async () => {
    ExecutionGate.configure({ safe: false, interactive: true, guards: [] });
    await expect(ExecutionGate.allow("ok")).resolves.toBe(true);
  });

  it("returns false when a guard blocks", async () => {
    const guard = { allow: mock(() => false) };
    ExecutionGate.configure({ safe: false, interactive: true, guards: [guard] });

    // This will FAIL until ExecutionGate.allow() awaits gate():
    //   static async allow(hint: string) {
    //     try { await this.gate(hint); return true; } catch { return false; }
    //   }
    await expect(ExecutionGate.allow("blocked")).resolves.toBe(false);
  });

  it("returns false when user denies in safe mode", async () => {
    ExecutionGate.configure({ safe: true, interactive: true, guards: [] });
    promptLineMock.mockImplementationOnce(async () => "no");

    // Also depends on awaiting gate() in allow()
    await expect(ExecutionGate.allow("danger")).resolves.toBe(false);
  });
});