// src/idsl/broker.ts
// Query → WorkingSet: resolve targets, build closure, map to pages & code slices.

import {
  Edge, IndexData, Node, NodeId, Page, PathSpan, WorkingSet
} from "./types";

export type Intent =
  | "rename"
  | "add-method"
  | "delete"
  | "find-callers"
  | "find-implementers"
  | "custom";

export interface Query {
  intent: Intent;
  targets: string[]; // e.g., ["interface:IStore.add"] or raw names
  maxDepth?: number; // BFS depth for closure (default varies by intent)
}

function normalizeTarget(t: string): string {
  // Accept "kind:name" or just "name"
  return t.includes(":") ? t : `fn:${t}`;
}

function resolveTargets(targets: string[], index: IndexData): NodeId[] {
  const out: NodeId[] = [];
  for (const raw of targets) {
    const key = normalizeTarget(raw);
    // exact id match wins
    if (index.nodes.has(key as any)) {
      out.push(key as any);
      continue;
    }
    // fallback: name match on suffix after kind:
    const name = key.split(":").slice(1).join(":");
    const found = [...index.nodes.values()].find(n => n.name === name);
    if (found) out.push(found.id);
  }
  return out;
}

function relationPolicy(intent: Intent): Set<string> {
  switch (intent) {
    case "rename":
    case "add-method":
      return new Set(["implements", "calls", "imports", "depends_on", "owns"]);
    case "find-implementers":
      return new Set(["implements"]);
    case "find-callers":
      return new Set(["calls"]);
    case "delete":
      return new Set(["imports", "depends_on", "calls", "implements"]);
    default:
      return new Set(["calls", "imports", "implements", "depends_on", "owns"]);
  }
}

export function closure(
  seeds: NodeId[],
  index: IndexData,
  maxDepth: number,
  allowedRels: Set<string>
): Set<NodeId> {
  const Q: Array<{ id: NodeId; d: number }> = [];
  const seen = new Set<NodeId>();
  for (const s of seeds) {
    Q.push({ id: s, d: 0 });
    seen.add(s);
  }
  while (Q.length > 0) {
    const cur = Q.shift()!;
    if (cur.d >= maxDepth) continue;
    const outs = index.adjOut.get(cur.id) ?? [];
    const ins = index.adjIn.get(cur.id) ?? [];
    for (const e of outs) {
      if (!allowedRels.has(e.rel)) continue;
      if (!seen.has(e.to)) {
        seen.add(e.to);
        Q.push({ id: e.to, d: cur.d + 1 });
      }
    }
    for (const e of ins) {
      if (!allowedRels.has(e.rel)) continue;
      if (!seen.has(e.from)) {
        seen.add(e.from);
        Q.push({ id: e.from, d: cur.d + 1 });
      }
    }
  }
  return seen;
}

export function collectPathSpans(nodes: Node[], selected: Set<NodeId>): PathSpan[] {
  const out: PathSpan[] = [];
  for (const n of nodes) {
    if (!selected.has(n.id)) continue;
    if (n.path) out.push(n.path);
  }
  return out;
}

export interface BrokerConfig {
  defaultDepthRename: number;       // e.g., 1
  defaultDepthAddMethod: number;    // e.g., 1
  defaultDepthDelete: number;       // e.g., 2
  defaultDepthFind: number;         // e.g., 2
}

export function broker(
  q: Query,
  index: IndexData,
  pages: Page[],
  cfg: BrokerConfig
): WorkingSet {
  const seeds = resolveTargets(q.targets, index);
  const depth =
    q.maxDepth ??
    (q.intent === "rename" ? cfg.defaultDepthRename :
     q.intent === "add-method" ? cfg.defaultDepthAddMethod :
     q.intent === "delete" ? cfg.defaultDepthDelete :
     cfg.defaultDepthFind);

  const allowed = relationPolicy(q.intent);
  const nodeSet = closure(seeds, index, depth, allowed);

  // Map to pages
  const pageByNode = new Map<string, Page>();
  for (const p of pages) for (const n of p.nodes) pageByNode.set(String(n), p);
  const wsPages: Page[] = [];
  const seenP = new Set<string>();
  for (const id of nodeSet) {
    const p = pageByNode.get(String(id));
    if (!p) continue;
    if (!seenP.has(String(p.id))) {
      seenP.add(String(p.id));
      wsPages.push(p);
    }
  }

  // Collect code slices for selected nodes
  const nodeList = [...index.nodes.values()];
  const slices = collectPathSpans(nodeList, nodeSet);

  return { pages: wsPages, slices, nodes: [...nodeSet] };
}
