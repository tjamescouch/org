// src/input/__tests__/tty-controller.keys.test.ts
import { describe, test, expect } from "bun:test";
import { TtyController } from "../../input/tty-controller";

describe("TtyController API surface", () => {
  test("exposes start/setScheduler/unwind/askUser/helpers", () => {
    const stdin = { isTTY: false } as unknown as NodeJS.ReadStream;
    const stdout = {} as unknown as NodeJS.WriteStream;
    const ctl = new TtyController({
      stdin, stdout, prompt: "You > ", interjectKey: "i", interjectBanner: "You > ",
    });
    expect(typeof ctl.start).toBe("function");
    expect(typeof ctl.setScheduler).toBe("function");
    expect(typeof ctl.unwind).toBe("function");
    expect(typeof ctl.askUser).toBe("function");
    expect(typeof ctl.withCookedTTY).toBe("function");
    expect(typeof ctl.withRawTTY).toBe("function");
  });
});
