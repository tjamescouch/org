// src/sandbox/sh-result.ts
export type ShResult = {
  code?: number | null;
  stdout?: string;
  stderr?: string;
};

function trimOrUndefined(s?: string) {
  const t = (s ?? "").trim();
  return t.length ? t : undefined;
}

/**
 * Ensures a shell result represents success. Treats undefined/null code as 0.
 * Throws with a helpful message if non-zero. Returns the same object otherwise.
 */
export function ensureOk<T extends ShResult>(r: T, context = "command"): T {
  const code = typeof r.code === "number" ? r.code : 0; // tolerate missing code as success
  if (code === 0) return r;

  const msg = trimOrUndefined(r.stderr) ?? trimOrUndefined(r.stdout) ?? "unknown error";
  const err = new Error(`${context} failed (code ${code}): ${msg}`);
  // Preserve raw output for callers that want to inspect it
  (err as any).stdout = r.stdout;
  (err as any).stderr = r.stderr;
  (err as any).code = code;
  throw err;
}
