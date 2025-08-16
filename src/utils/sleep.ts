/**
 * Sleep for a given number of milliseconds.
 * Works in both Node.js and Bun.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // Node and Bun both implement setTimeout the same way.
    const timer = setTimeout(() => {
      resolve();
    }, ms);

    // In Node, return type of setTimeout is a Timeout object;
    // in Bun, it’s a number. Clearing works in both.
    if (typeof timer === "object" && typeof (timer as any).unref === "function") {
      // Allow program to exit naturally without waiting for the timer
      (timer as any).unref();
    }
  });
}
