import { describe, test, expect } from "bun:test";
import {
  TtyController,
  withCookedTTY,
  withRawTTY,
} from "../../input/tty-controller";

class FakeTty {
  isTTY = true;
  isRaw = false;
  setRawMode(mode: boolean) { this.isRaw = mode; }
  // minimal stubs to satisfy possible listeners (not used in these tests)
  on() { return this; }
  off() { return this; }
}

class FakeOut {
  write(_s: string) { /* noop */ return true; }
}

describe("tty-controller public API", () => {
  test("class exposes scoped helpers (raw/cooked toggling)", async () => {
    const fakeIn = new FakeTty();
    const fakeOut = new FakeOut();
    const ctl = new TtyController({ stdin: fakeIn as any, stdout: fakeOut as any });

    // starts cooked if isRaw=false
    expect(fakeIn.isRaw).toBe(false);

    await ctl.withRawTTY(async () => {
      expect(fakeIn.isRaw).toBe(true);
    });

    // restored to cooked after scope
    expect(fakeIn.isRaw).toBe(false);

    // cooked scope keeps it cooked
    await ctl.withCookedTTY(async () => {
      expect(fakeIn.isRaw).toBe(false);
    });
    expect(fakeIn.isRaw).toBe(false);
  });

  test("named helpers are functions and execute the callback", async () => {
    expect(typeof withCookedTTY).toBe("function");
    expect(typeof withRawTTY).toBe("function");

    // Just verify they run and return the callback's value.
    const a = await withCookedTTY(async () => 123);
    expect(a).toBe(123);

    const b = await withRawTTY(async () => "ok");
    expect(b).toBe("ok");

  });
});
