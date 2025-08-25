// src/__tests__/esc_graceful-exit.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { EventEmitter } from "events";

// simple spy
function createSpy<T extends (...args: any[]) => any>(impl?: T) {
  const fn: any = (...args: any[]) => {
    fn.calls.push(args);
    return impl?.(...args);
  };
  fn.calls = [] as any[];
  return fn as T & { calls: any[] };
}

// minimal scheduler stub
class SchedulerStub extends EventEmitter {
  stop = createSpy(() => {});
  drain = async () => {};
  stopDraining = () => {};
  isDraining = () => false;
}

let fakeStdin: any;
let InputController: any;

beforeEach(() => {
  // fresh fake stdin each time
  fakeStdin = new EventEmitter();
  fakeStdin.isTTY = true;
  fakeStdin.setRawMode = () => {};

  // swap process.stdin
  Object.defineProperty(process, "stdin", { value: fakeStdin });
  // clear module cache so we import controller after patching stdin
  const k = require.resolve("../../controller");
  delete require.cache[k];
  InputController = require("../../controller").InputController || require("../../controller").default;
});

describe("ESC graceful shutdown", () => {
  it("calls scheduler.stop() and finalizer()", async () => {
    const scheduler = new SchedulerStub();
    const finalizer = createSpy(() => {});

    const c = new InputController({
      interjectKey: "i",
      // inject finalizer via option if supported; otherwise, attach later (see below)
      finalizeSandbox: finalizer, // if your controller constructor accepts this
    } as any);

    // if your controller doesn't take finalize in constructor, assign hook directly:
    (c as any)._onFinalizeSandbox = finalizer;

    c.attachScheduler(scheduler as any);

    // simulate ESC
    fakeStdin.emit("keypress", "", { name: "escape" });

    expect(scheduler.stop.calls.length).toBe(1);
    expect(finalizer.calls.length).toBe(1);
  });
});
