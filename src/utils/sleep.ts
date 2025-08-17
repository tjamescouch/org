/**
 * Portable sleep that works in both Node and Bun.
 * Uses setTimeout under the hood.
 */
export function sleep(ms: number): Promise<void> {
  const wait = Math.max(0, Number(ms) || 0);
  return new Promise<void>((resolve) => {
    const id = setTimeout(() => resolve(), wait);
    // No platform-specific cleanup necessary; leaving here for future extensibility.
    void id;
  });
}
