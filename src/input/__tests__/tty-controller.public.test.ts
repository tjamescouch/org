import { describe, test, expect } from "bun:test";
import { TtyController, type TtyIn } from "../../input/tty-controller";

class FakeTty implements TtyIn {
  isTTY = true;
  isRaw = false;
  setRawMode(mode: boolean) { this.isRaw = mode; }
}

describe("TtyController public API", () => {
  test.skip("scoped cooked/raw restore properly", async () => {
    const stdin: NodeJS.ReadStream = { isTTY: true } as unknown as NodeJS.ReadStream;
    const stdout: NodeJS.WriteStream = {} as unknown as NodeJS.WriteStream;
    const ctl = new TtyController({
      stdin, stdout, prompt: "You > ", interjectKey: "i", interjectBanner: "You > ",
    });

    // use the controller's scoped helpers
    await ctl.withRawTTY(async () => {
      await ctl.withCookedTTY(async () => { /* nested OK */ });
    });
  });

  test("exposes start/setScheduler/unwind/askUser", async () => {
    const stdin: NodeJS.ReadStream = { isTTY: false } as unknown as NodeJS.ReadStream;
    const stdout: NodeJS.WriteStream = {} as unknown as NodeJS.WriteStream;
    const ctl = new TtyController({
      stdin, stdout, prompt: "You > ", interjectKey: "i", interjectBanner: "You > ",
    });

    expect(typeof ctl.start).toBe("function");
    expect(typeof ctl.setScheduler).toBe("function");
    expect(typeof ctl.unwind).toBe("function");
    expect(typeof ctl.askUser).toBe("function");
  });
});
