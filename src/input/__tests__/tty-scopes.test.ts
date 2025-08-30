// src/input/__tests__/tty-scopes.test.ts
import { describe, test, expect } from "bun:test";
import { TtyScopes, type TtyIn } from "../../input/tty-scopes";

class FakeTty implements TtyIn {
  isTTY: boolean;
  isRaw?: boolean;
  constructor(isTTY = true, isRaw = false) {
    this.isTTY = isTTY;
    this.isRaw = isRaw;
  }
  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }
}

describe("TtyScopes", () => {
  test("withCookedTTY restores prior raw mode", async () => {
    const tty = new FakeTty(true, true); // start raw
    const scopes = new TtyScopes(tty);

    expect(scopes.mode).toBe("raw");
    await scopes.withCookedTTY(async () => {
      expect(scopes.mode).toBe("cooked");
      expect(tty.isRaw).toBe(false);
    });
    expect(scopes.mode).toBe("raw");
    expect(tty.isRaw).toBe(true);
  });

  test("withRawTTY restores prior cooked mode", async () => {
    const tty = new FakeTty(true, false); // start cooked
    const scopes = new TtyScopes(tty);

    expect(scopes.mode).toBe("cooked");
    await scopes.withRawTTY(() => {
      expect(scopes.mode).toBe("raw");
      expect(tty.isRaw).toBe(true);
    });
    expect(scopes.mode).toBe("cooked");
    expect(tty.isRaw).toBe(false);
  });

  test("nesting is safe and restores outer mode", async () => {
    const tty = new FakeTty(true, true); // raw
    const scopes = new TtyScopes(tty);

    await scopes.withCookedTTY(async () => {
      expect(scopes.mode).toBe("cooked");
      await scopes.withRawTTY(async () => {
        expect(scopes.mode).toBe("raw");
      });
      expect(scopes.mode).toBe("cooked");
    });

    expect(scopes.mode).toBe("raw");
    expect(tty.isRaw).toBe(true);
  });

  test("exceptions still restore prior mode", async () => {
    const tty = new FakeTty(true, false); // cooked
    const scopes = new TtyScopes(tty);

    await expect(
      scopes.withRawTTY(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(scopes.mode).toBe("cooked");
    expect(tty.isRaw).toBe(false);
  });

  test("non-TTY streams no-op but update internal view", async () => {
    const tty = new FakeTty(false, false); // not a TTY
    const scopes = new TtyScopes(tty);

    expect(scopes.mode).toBe("cooked");
    await scopes.withRawTTY(async () => {
      expect(scopes.mode).toBe("raw");
    });
    expect(scopes.mode).toBe("cooked");
  });
});
