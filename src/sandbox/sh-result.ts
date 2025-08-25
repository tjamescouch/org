export type ShResult = {
  code?: number | null;
  stdout?: string;
  stderr?: string;
};

function trimOrUndefined(s?: string) {
  const t = (s ?? "").trim();
  return t.length ? t : undefined;
}

export function ensureOk<T extends ShResult>(r: T, context = "command"): T {
  const code = typeof r.code === "number" ? r.code : 0;
  if (code === 0) return { ...r, code: 0};

  const msg = trimOrUndefined(r.stderr) ?? trimOrUndefined(r.stdout) ?? "unknown error";
  const err = new Error(`${context} failed (code ${code}): ${msg}`);
  (err as any).stdout = r.stdout;
  (err as any).stderr = r.stderr;
  (err as any).code = code;
  throw err;
}
