import { describe, test, expect } from "bun:test";
import {
  TtyController,
  withCookedTTY,
  withRawTTY,
  defaultTtyController,
} from "../../input/tty-controller";

class FakeTty {
  isTTY = true;
  isRaw = false;
  setRawMode(mode: boolean) { this.isRaw = mode; }
}

describe("tty-controller public API", () => {
  test("class exposes scoped helpers", async () => {
    const ctl = new TtyController(new FakeTty());
    expect(ctl.mode).toBe("cooked");
    await ctl.withRawTTY(async () => {
      expect(ctl.mode).toBe("raw");
    });
    expect(ctl.mode).toBe("cooked");
  });

  test("named helpers are functions", async () => {
    expect(typeof withCookedTTY).toBe("function");
    expect(typeof withRawTTY).toBe("function");
    await withCookedTTY(async () => {
      expect(defaultTtyController.mode).toBe("cooked");
    });
  });
});
