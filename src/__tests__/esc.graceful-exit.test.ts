// src/__tests__/__esc_graceful-exit.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
// NOTE: path is from src/__tests__ to src/controller.ts
import { makeControllerForTests } from "../input/controller";

describe("ESC graceful shutdown vs Ctrl+C", () => {
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

  it("ESC calls scheduler.stop() and finalizer()", async () => {
    let stopped = 0;
    let finalized = 0;

    const scheduler: any = {
      stop: () => { stopped++; },
      isDraining: () => false,
      drain: async () => {},
      stopDraining: () => {},
      handleUserInterjection: (_: string) => {},
    };

    const ctl = makeControllerForTests({
      scheduler,
      finalizer: async () => { finalized++; },
    });

    ctl._private.emitKey({ name: "escape" });
    await Promise.resolve(); // allow microtask

    expect(stopped).toBe(1);
    expect(finalized).toBe(1);
  });

  it("Ctrl+C exits fast (no finalize)", async () => {
    let stopped = 0;
    let finalized = 0;

    const scheduler: any = {
      stop: () => { stopped++; },
      isDraining: () => false,
      drain: async () => {},
      stopDraining: () => {},
      handleUserInterjection: (_: string) => {},
    };

    const ctl = makeControllerForTests({
      scheduler,
      finalizer: async () => { finalized++; },
    });

    // simulate Ctrl+C
    ctl._private.emitKey({ name: "c", ctrl: true });
    await Promise.resolve();

    // Fast path should NOT call stop/finalize
    expect(stopped).toBe(0);
    expect(finalized).toBe(0);
  });
});

