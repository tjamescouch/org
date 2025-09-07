// src/ui/pretty.ts
import { Logger, C } from "../logger";
import { R } from "../runtime/runtime";

type Row = { label: string; value: string };

function getTty() {
  const force = R.env.ORG_FORCE_TTY === "1";
  const out = (R.stdout as any);
  const err = (R.stderr as any);
  const isTTY = !!out?.isTTY || !!err?.isTTY;
  const tty = force ? true : isTTY;
  const columns = (tty && (out?.columns || err?.columns)) || 80;
  return { tty, columns: Math.max(40, Math.min(100, Number(columns))) };
}

export function printInitCard(title: string, rows: Row[]): void {
  const { tty, columns } = getTty();

  Logger.info("here")
  if (!tty) {
  Logger.info("here 2")
    for (const r of rows) Logger.info(`[${title}] ${r.label} = ${r.value}`);
    return;
  }
  Logger.info("here 3")

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
