// src/idsl/cli.ts
// Tiny CLI: read JSONL, paginate, render pages to stdout or folder.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex, loadJsonl } from "./jsonl";
import { graphToPages } from "./pager";
import { renderPage } from "./render";
import { IndexData, Page } from "./types";

type Args = {
  in: string;
  out?: string;
  cap?: number; // page token cap
};

function parseArgs(argv: string[]): Args {
  const args: Args = { in: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.in = argv[++i] ?? "";
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--cap") args.cap = Number(argv[++i]);
  }
  if (!args.in) throw new Error("Usage: idsl --in <file.jsonl> [--out dir] [--cap 1200]");
  return args;
}

export function runCli(argv: string[]) {
  const args = parseArgs(argv);
  const text = readFileSync(args.in, "utf8");
  const { nodes, edges } = loadJsonl(text);
  const index = buildIndex(nodes, edges);
  const pages = graphToPages(index, { pageTokenCap: args.cap ?? 1200 });

  if (!args.out) {
    for (const p of pages) {
      const rendered = renderPage(p, new Map([...index.nodes].map(([k, v]) => [String(k), v])));
      console.log(rendered + "\n");
    }
    return;
  }
  mkdirSync(args.out, { recursive: true });
  const nodeMap = new Map([...index.nodes].map(([k, v]) => [String(k), v]));
  for (const p of pages) {
    const txt = renderPage(p, nodeMap);
    writeFileSync(join(args.out, `${String(p.id)}.idsl`), txt, "utf8");
    writeFileSync(join(args.out, `${String(p.id)}.json`), JSON.stringify(p, null, 2), "utf8");
  }
  console.error(`Wrote ${pages.length} pages to ${args.out}`);
}

if (require.main === module) {
  runCli(process.argv);
}
