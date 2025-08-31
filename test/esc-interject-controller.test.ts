// test/esc-interject-controller.test.ts
import { expect, test } from "bun:test";
import {
  EscInterjectController,
  RunPhase,
  ReviewOpener,
  InterjectionOpener,
} from "../src/input/esc-interject-controller";

function mkController(flags: {
  interactive: boolean;
  reviewSpy?: { calls: number };
  interjectSpy?: { calls: number };
}) {
  const reviewCalls = flags.reviewSpy ?? { calls: 0 };
  const interjectCalls = flags.interjectSpy ?? { calls: 0 };

  const review: ReviewOpener = {
    finalizeAndReview: async () => {
      reviewCalls.calls++;
      return { patchProduced: true, applied: false };
    },
  };
  const interject: InterjectionOpener = {
    openInterjectionPrompt: async () => {
      interjectCalls.calls++;
    },
  };

  const ctrl = new EscInterjectController({
    isInteractive: () => flags.interactive,
    logger: { info: () => {}, warn: () => {} },
    review,
    interject,
  });
  return { ctrl, reviewCalls, interjectCalls };
}

test("`i` during streaming queues and opens after stream end (interactive only)", async () => {
  const spies = { calls: 0 };
  const { ctrl, interjectCalls } = mkController({
    interactive: true,
    interjectSpy: spies,
  });

  ctrl.onStreamStart();
  ctrl.handleInterjectKey(); // queue during stream
  expect(interjectCalls.calls).toBe(0);

  ctrl.onStreamEnd(); // should open exactly once
  // microtask tick for async openInterjectionPrompt
  await Promise.resolve();
  expect(interjectCalls.calls).toBe(1);
});

test("ESC during streaming delays review until stream end (then opens once)", async () => {
  const reviewSpy = { calls: 0 };
  const { ctrl, reviewCalls } = mkController({
    interactive: true,
    reviewSpy,
  });

  ctrl.onStreamStart();
  ctrl.handleEscKey();
  expect(reviewCalls.calls).toBe(0);

  ctrl.onStreamEnd(); // triggers finalize+review
  await Promise.resolve();
  expect(reviewCalls.calls).toBe(1);

  // Pressing ESC again shouldn't open a second review immediately
  ctrl.handleEscKey();
  await Promise.resolve();
  expect(reviewCalls.calls).toBe(2); // opens once more from Idle (explicit second request)
});
