// src/ui/pretty.ts
// Minimal, dependency-free helpers to render a cleaner startup banner.
//
// Design goals:
// - No new npm deps; ANSI only.
// - TTY-aware: falls back to simple [org] k=v lines when not a TTY.
// - Conservative width usage; never throws if `columns` is missing.

import { C, Logger } from "../logger";
import { R } from "../runtime/runtime";

type Row = { label: string; value: string };

/** Render a compact "status card" with aligned key/value rows. */
export function printInitCard(title: string, rows: Row[]): void {
  // Non-interactive: keep the previous simple lines for log parsers.
  const out = R.stdout as undefined | (NodeJS.WriteStream & { columns?: number });
  if (!out?.isTTY) {
    for (const r of rows) Logger.info(`[${title}] ${r.label} = ${r.value}`);
    return;
  }

  const cols = Math.max(40, Math.min(100, Number(out.columns || 80)));
  const border = "─".repeat(cols - 2);

  const maxLabel = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

  Logger.info(`${C.gray("┌" + border)}`);
  // header line — intentionally subtle
  Logger.info(`${C.gray("│")} ${C.bold(C.magenta(title))}`);
  for (const r of rows) {
    const l = pad(r.label, maxLabel);
    Logger.info(`${C.gray("│")} ${C.gray(l)}  ${r.value}`);
  }
  Logger.info(`${C.gray("└" + border)}`);
}
