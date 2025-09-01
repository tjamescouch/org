// test/helpers/spy.ts
// Minimal manual spy: wraps an object's method, records calls, preserves behavior.

type Spy<T extends object, K extends keyof T & string> = {
  /** Restore the original method. Always call in a finally {} block. */
  restore(): void;
  /** All invocations as arrays of arguments. */
  calls: Array<Parameters<Extract<T[K], (...args: any[]) => any>>>;
  /** Convenience: number of calls. */
  callCount(): number;
};

/**
 * Replace obj[method] with a wrapper that records calls and calls through.
 * Throws if the property is not a function.
 */
export function spyMethod<T extends Record<string, any>, K extends keyof T & string>(
  obj: T,
  method: K,
): Spy<T, K> {
  const original = obj[method];
  if (typeof original !== "function") {
    throw new Error(`spyMethod: ${String(method)} is not a function on target object`);
  }
  const calls: any[][] = [];

  const wrapped = (...args: any[]) => {
    calls.push(args);
    // Call through to preserve behavior / side-effects:
    return (original as (...a: any[]) => any).apply(obj, args);
  };

  // Replace the method
  (obj as any)[method] = wrapped;

  return {
    restore() {
      (obj as any)[method] = original;
    },
    calls,
    callCount() {
      return calls.length;
    },
  };
}
