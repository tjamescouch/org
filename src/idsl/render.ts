// src/idsl/render.ts
// Human-readable IDSL rendering + token cost + degradation

import {
  DegradationLevel, Edge, Node, Page, PathSpan, estimateTokensFromChars,
  pathSpanToString
} from "./types";

export function renderNode(n: Node, level: DegradationLevel): string {
  const p = pathSpanToString(n.path);
  const V = n.attrs.version !== undefined ? ` v${n.attrs.version}` : "";
  const pathPart = p ? ` path=${p}` : "";

  switch (level) {
    case 0: {
      const chunks: string[] = [];
      if (n.attrs.stability) chunks.push(`stability=${n.attrs.stability}`);
      if (n.attrs.churn) chunks.push(`churn=${n.attrs.churn}`);
      if (n.attrs.owners?.length) chunks.push(`owner=${n.attrs.owners.map(o => `@${o}`).join(",")}`);
      if (n.attrs.hash) chunks.push(`hash=${n.attrs.hash}`);
      const extras = Object.entries(n.attrs.extra ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      const meta = [...chunks, ...extras].join(" ");
      const base = `${n.kind} ${n.name}${V}${pathPart}${meta ? " " + meta : ""}`;
      // include 1-line examples if present
      if (n.attrs.examples?.length) {
        const ex = n.attrs.examples.map(e => `example ${n.name} "${e}"`).join("\n");
        return `${base}\n${ex}`;
      }
      return base;
    }
    case 1: {
      const chunks: string[] = [];
      if (n.attrs.stability) chunks.push(`stability=${n.attrs.stability}`);
      if (n.attrs.churn) chunks.push(`churn=${n.attrs.churn}`);
      const meta = chunks.join(" ");
      return `${n.kind} ${n.name}${V}${pathPart}${meta ? " " + meta : ""}`;
    }
    case 2: {
      // keep file only; drop exact spans
      const fileOnly = n.path ? ` path=${n.path.file}` : "";
      return `${n.kind} ${n.name}${V}${fileOnly}`;
    }
    case 3:
    default:
      return `${n.kind} ${n.name}${V}`;
  }
}

export function renderEdge(e: Edge, level: DegradationLevel): string {
  switch (level) {
    case 0:
    case 1:
    case 2:
      return `edge ${e.rel} ${e.from} -> ${e.to}`;
    case 3:
    default:
      // collapse to relation label only at coarsest level
      return `edge ${e.rel}`;
  }
}

export function renderPage(page: Page, nodeLookup: Map<string, Node>): string {
  const buf: string[] = [];
  buf.push(`# PAGE ${page.id} level=${page.level} tokenCost=${page.tokenCost}`);
  // nodes
  for (const nid of page.nodes) {
    const n = nodeLookup.get(nid as unknown as string);
    if (!n) continue;
    buf.push(renderNode(n, page.level));
  }
  // edges (intra)
  for (const e of page.edges) buf.push(renderEdge(e, page.level));
  // summarize xedges minimally
  if (page.xedges.length && page.level <= 2) {
    buf.push(`# xedges ${page.xedges.length}`);
    for (const e of page.xedges.slice(0, 16)) {
      buf.push(`xedge ${e.rel} ${e.from} -> ${e.to}`);
    }
  }
  return buf.join("\n");
}

export function estimateTokenCostForPage(page: Page, nodes: Map<string, Node>): number {
  const text = renderPage(page, nodes);
  return estimateTokensFromChars(text.length);
}
