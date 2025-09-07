// src/ui/pretty.ts
// Dependency-free banner. Works even if a custom stream masks TTY-ness.

import { Logger, C } from "../logger";
import { R } from "../runtime/runtime";

type Row = { label: string; value: string };

function getTtyInfo() {
  // Prefer real Node streams; fall back to runtime’s streams.
  // Allow forcing interactivity via ORG_FORCE_TTY=1 (useful in containers).
  const force = R.env.ORG_FORCE_TTY === "1";
  const out = (R.stdout as NodeJS.WriteStream | undefined) ?? (R.stdout as any);
  const err = (R.stderr as NodeJS.WriteStream | undefined) ?? (R.stderr as any);
  const anyTty = !!(out && (out as any).isTTY) || !!(err && (err as any).isTTY);

  const tty = force ? true : anyTty;
  const columns =
    (tty && typeof (out as any)?.columns === "number" && (out as any).columns) ||
    (tty && typeof (err as any)?.columns === "number" && (err as any).columns) ||
    80;

  return { tty, columns: Math.max(40, Math.min(100, Number(columns))) };
}

/** Render a compact, aligned key/value "status card". */
export function printInitCard(title: string, rows: Row[]): void {
  const { tty, columns } = getTtyInfo();

  if (!tty) {
    // Non-interactive: log terse k=v lines (grep-friendly).
    for (const r of rows) Logger.info(`[${title}] ${r.label} = ${r.value}`);
    return;
  }

  const border = "─".repeat(columns - 2);
  const maxLabel = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

  Logger.info(C.gray("┌" + border));
  Logger.info(`${C.gray("│")} ${C.bold(C.magenta(title))}`);
  for (const r of rows) {
    const l = pad(r.label, maxLabel);
    Logger.info(`${C.gray("│")} ${C.gray(l)}  ${r.value}`);
  }
  Logger.info(C.gray("└" + border));
}
