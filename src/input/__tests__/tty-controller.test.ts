// src/input/__tests__/tty-controller.test.ts
import { describe, test, expect } from "bun:test";
import { TtyController, type TtyIn } from "../../input/tty-controller";

class FakeTty implements TtyIn {
  isTTY: boolean;
  isRaw?: boolean;
  constructor(init: { isTTY: boolean; isRaw?: boolean }) {
    this.isTTY = init.isTTY;
    this.isRaw = init.isRaw ?? false;
  }
  setRawMode(mode: boolean): void {
    // Simulate Node's ReadStream behavior.
    this.isRaw = mode;
  }
}

describe("TtyController", () => {
  test("withCookedTTY restores prior raw mode", async () => {
    const tty = new FakeTty({ isTTY: true, isRaw: true }); // start raw
    const ctl = new TtyController(tty);

    expect(ctl.mode).toBe("raw");
    await ctl.withCookedTTY(async () => {
      expect(ctl.mode).toBe("cooked");
      expect(tty.isRaw).toBe(false);
    });

    expect(ctl.mode).toBe("raw");
    expect(tty.isRaw).toBe(true);
  });

  test("withRawTTY restores prior cooked mode", async () => {
    const tty = new FakeTty({ isTTY: true, isRaw: false }); // start cooked
    const ctl = new TtyController(tty);

    expect(ctl.mode).toBe("cooked");
    await ctl.withRawTTY(() => {
      expect(ctl.mode).toBe("raw");
      expect(tty.isRaw).toBe(true);
    });

    expect(ctl.mode).toBe("cooked");
    expect(tty.isRaw).toBe(false);
  });

  test("nesting is safe and restores outer mode", async () => {
    const tty = new FakeTty({ isTTY: true, isRaw: true }); // raw
    const ctl = new TtyController(tty);

    await ctl.withCookedTTY(async () => {
      expect(ctl.mode).toBe("cooked");
      await ctl.withRawTTY(async () => {
        expect(ctl.mode).toBe("raw");
      });
      expect(ctl.mode).toBe("cooked");
    });

    expect(ctl.mode).toBe("raw");
    expect(tty.isRaw).toBe(true);
  });

  test("exceptions still restore prior mode", async () => {
    const tty = new FakeTty({ isTTY: true, isRaw: false }); // cooked
    const ctl = new TtyController(tty);

    await expect(
      ctl.withRawTTY(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(ctl.mode).toBe("cooked");
    expect(tty.isRaw).toBe(false);
  });

  test("non-TTY streams don't throw and update internal view", async () => {
    const tty: TtyIn = { isTTY: false };
    const ctl = new TtyController(tty);

    expect(ctl.mode).toBe("cooked"); // default
    await ctl.withRawTTY(async () => {
      expect(ctl.mode).toBe("raw");
    });
    expect(ctl.mode).toBe("cooked");
  });
});
