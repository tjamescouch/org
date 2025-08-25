// src/__tests__/__esc_graceful-exit.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
// NOTE: path is from src/__tests__ to src/controller.ts
import { makeControllerForTests } from "../input/controller";

describe("ESC graceful shutdown", () => {
  let stopped = 0;
  let finalized = 0;
  let ctl: ReturnType<typeof makeControllerForTests> | null = null;

  beforeEach(() => {
    stopped = 0;
    finalized = 0;

    const scheduler = {
      stop: () => {
        stopped++;
      },
      isDraining: () => false,
      drain: async () => {},
      stopDraining: () => {},
      handleUserInterjection: (_s: string) => {},
    };

    const finalizer = async () => {
      finalized++;
    };

    ctl = makeControllerForTests({ scheduler: scheduler as any, finalizer });
  });

  afterEach(() => {
    // dispose if your helper returns one; otherwise ignore
    ctl = null;
  });

  it("calls scheduler.stop() and finalizer() on ESC", async () => {
    // simulate ESC keypress via helper
    ctl!._private.emitKey({ name: "escape" });

    // give the controller microtask tick if it schedules finalization
    await Promise.resolve();

    expect(stopped).toBe(1);
    expect(finalized).toBe(1);
  });
});
