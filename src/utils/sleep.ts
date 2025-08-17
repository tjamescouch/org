export function sleep(ms: number, opts: { allowEarlyExit?: boolean } = {}) {
  return new Promise<void>((resolve) => {
    const t: any = setTimeout(resolve, ms);
    if (opts.allowEarlyExit && typeof t.unref === "function") t.unref();
  });
}
