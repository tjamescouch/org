import { Logger } from "./logger";

export function printBanner(opts?: { safe?: boolean }) {
  const safe = !!opts?.safe;
  const lines = [
    "",
    "┌──────────────────────────────────────────────────────────┐",
    "│ org: interactive controls                                │",
    "│   i  → interject as user                                 │",
    "│   s  → send system message                               │",
    "│   q  → quit                                              │",
    `│   safe-mode: ${safe ? "ON (press Enter before each step)" : "OFF"}`.padEnd(58, " "),
    "└──────────────────────────────────────────────────────────┘",
    "",
  ];
  for (const ln of lines) Logger.info(ln);
}
