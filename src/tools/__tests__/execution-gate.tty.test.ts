import { describe, test, expect } from "bun:test";
import { TtyScopes, type TtyIn } from "../../input/tty-scopes";
import { confirmAllowed } from "../../tools/execution-gate";

// Test double: minimal TTY impl.
class FakeTty implements TtyIn {
  isTTY: boolean = true;
  isRaw?: boolean = false;
  setRawMode(mode: boolean) { this.isRaw = mode; }
}

describe("ExecutionGate confirmation runs in cooked TTY", () => {
  test("restores prior mode after prompt even on success", async () => {
    const tty = new FakeTty();
    const scopes = new TtyScopes(tty);

    // Simulate outer raw context
    scopes.setMode("raw");
    expect(tty.isRaw).toBe(true);

    const yes = await scopes.withRawTTY(async () => {
      // call the gate; it should flip to cooked for the prompt
      const answer = await confirmAllowed("ok?", {
        defaultYes: false,
        promptYesNo: async (_msg, _def) => {
          expect(tty.isRaw).toBe(false); // cooked within the prompt
          return true;
        }
      });
      return answer;
    });

    expect(yes).toBe(true);
    expect(tty.isRaw).toBe(true); // restored to raw after prompt
  });

  test("restores prior mode after prompt even on error", async () => {
    const tty = new FakeTty();
    const scopes = new TtyScopes(tty);
    scopes.setMode("raw");

    await expect(scopes.withRawTTY(async () => {
      await confirmAllowed("throw?", {
        defaultYes: false,
        promptYesNo: async () => {
          expect(tty.isRaw).toBe(false);
          throw new Error("boom");
        }
      });
    })).rejects.toThrow("boom");

    expect(tty.isRaw).toBe(true); // restored after exception
  });
});
