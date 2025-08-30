import { describe, test, expect } from "bun:test";
import { toTtyIn, stdinTty } from "../../input/tty-adapter";
import type { ReadStream as TtyReadStream } from "node:tty";

function makeFakeStream(opts: {
  isTTY: boolean;
  isRaw?: boolean;
  setRawMode?: (m: boolean) => void;
}): NodeJS.ReadStream {
  const s = {
    isTTY: opts.isTTY,
    ...(opts.isRaw !== undefined ? { isRaw: opts.isRaw } : {}),
    ...(opts.setRawMode ? { setRawMode: opts.setRawMode } : {}),
  };
  // No `as any`: narrow to a compatible structural type, then to ReadStream.
  return s as unknown as NodeJS.ReadStream;
}

describe("tty-adapter", () => {
  test("adapts a non-TTY safely", () => {
    const rs = makeFakeStream({ isTTY: false });
    const tty = toTtyIn(rs);
    expect(tty.isTTY).toBe(false);
    expect("setRawMode" in tty ? typeof tty.setRawMode : "none").toBe("none");
  });

  test("adapts a TTY with setRawMode and isRaw", () => {
    let last: boolean | undefined;
    const rs = makeFakeStream({
      isTTY: true,
      isRaw: false,
      setRawMode: (m) => { last = m; },
    });
    const tty = toTtyIn(rs);
    expect(tty.isTTY).toBe(true);
    expect(tty.isRaw).toBe(false);
    expect(typeof tty.setRawMode).toBe("function");
    tty.setRawMode?.(true);
    expect(last).toBe(true);
  });

  test("stdinTty returns a TtyIn", () => {
    const tty = stdinTty();
    expect(typeof tty.isTTY).toBe("boolean");
  });
});
