export function traceEnabled(): boolean {
  const e = process?.env || (globalThis as any)?.process?.env || {};
  if (!e) return false;
  return e.LLM_FILTER_DEBUG === "1" || /\bllmFilter\b/.test(String(e.ORG_TRACE || ""));
}

export function tracePass(
  pass: string,
  phase: "in" | "out",
  payload: { chunk?: string; cleaned?: string; tail?: string; note?: string }
) {
  if (!traceEnabled()) return;
  const mark = phase === "in" ? "→" : "←";
  const show = (s?: string) => (typeof s === "string" ? s.replace(/\n/g, "\\n") : String(s));
  const msg =
    `[llmFilter] ${mark} ${pass}` +
    (payload.note ? ` (${payload.note})` : "") +
    (payload.chunk !== undefined ? ` | chunk="${show(payload.chunk)}"` : "") +
    (payload.cleaned !== undefined ? ` | cleaned="${show(payload.cleaned)}"` : "") +
    (payload.tail !== undefined ? ` | tail="${show(payload.tail)}"` : "");
  // eslint-disable-next-line no-console
  console.debug(msg);
}
