// Wrap fetch so timeouts show WHERE they came from with a real stack.
export async function timedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number; where?: string } = {}
) {
  const { timeoutMs, where, ...rest } = init;
  let controller: AbortController | null = null;
  let timer: NodeJS.Timeout | null = null;

  try {
    if (timeoutMs && timeoutMs > 0) {
      controller = new AbortController();
      (rest as any).signal = controller.signal;
      timer = setTimeout(() => controller!.abort(), timeoutMs);
    }
    const res = await fetch(url, rest);
    return res;
  } catch (e: any) {
    // Normalize DOMException TimeoutError/AbortError to a regular Error with context.
    const err = new Error(
      `[fetch timeout] ${where ?? ""} ${url} -> ${e?.name || "Error"}: ${e?.message || e}`
    );
    (err as any).cause = e;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
