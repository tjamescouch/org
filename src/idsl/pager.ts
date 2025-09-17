// src/idsl/pager.ts
// Graph → Pages with fixed token cap, locality-aware growth, deterministic seeds.
// Progressive degradation L0→L3 and simple hotness/eviction helpers.

import {
  Edge, IndexData, Node, NodeId, Page, PageId, DegradationLevel,
  estimateTokensFromChars, AVG_CHARS_PER_TOKEN, clamp01
} from "./types";
import { fnv1a64 } from "./hash";
import { estimateTokenCostForPage } from "./render";

export interface PagerConfig {
  pageTokenCap: number;       // e.g., 1200
  avgCharsPerToken?: number;  // default 4
}

type MutablePage = {
  id: PageId;
  nodes: NodeId[];
  edges: Edge[];
  xedges: Edge[];
  tokenCost: number;
  level: DegradationLevel;
  hotness: number;
};

function tokenCostForNode(n: Node): number {
  // Rough cost: kind+name+path+attrs length / avg
  const approxChars =
    n.kind.length + n.name.length + (n.path ? n.path.file.length + 12 : 0) +
    JSON.stringify(n.attrs ?? {}).length + 16;
  return estimateTokensFromChars(approxChars);
}

function tokenCostForEdge(_: Edge): number {
  // Edges render short; budget ~6 tokens each
  return 6;
}

function buildAdjacency(index: IndexData): Map<NodeId, Set<NodeId>> {
  const adj = new Map<NodeId, Set<NodeId>>();
  for (const id of index.nodes.keys()) adj.set(id, new Set<NodeId>());
  for (const e of index.edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.add(e.to);
    adj.get(e.to)!.add(e.from);
  }
  return adj;
}

function pageIdFor(nodes: NodeId[]): PageId {
  const sorted = [...nodes].map(String).sort().join("|");
  return (`p:${fnv1a64(sorted)}`) as PageId;
}

function pickSeed(unassigned: Set<NodeId>, index: IndexData): NodeId {
  // Deterministic: highest degree, then name
  let best: NodeId | null = null;
  let bestDeg = -1;
  for (const id of unassigned) {
    const deg = (index.adjOut.get(id)?.length ?? 0) + (index.adjIn.get(id)?.length ?? 0);
    if (deg > bestDeg) {
      best = id;
      bestDeg = deg;
    } else if (deg === bestDeg && best !== null && String(id) < String(best)) {
      best = id;
    }
  }
  if (!best) {
    // should not happen
    return [...unassigned][0];
  }
  return best;
}

function scoreCandidate(
  cand: NodeId,
  pageNodes: Set<NodeId>,
  index: IndexData
): number {
  const outs = index.adjOut.get(cand) ?? [];
  const ins = index.adjIn.get(cand) ?? [];
  let intra = 0;
  let degree = outs.length + ins.length;
  for (const e of outs) if (pageNodes.has(e.to)) intra++;
  for (const e of ins) if (pageNodes.has(e.from)) intra++;
  const inter = Math.max(0, degree - intra);
  const node = index.nodes.get(cand)!;
  const cost = tokenCostForNode(node);
  return (intra + 1) / (inter + 1) / Math.max(1, cost);
}

export function graphToPages(index: IndexData, cfg: PagerConfig): Page[] {
  const PAGE_TOKENS = Math.max(200, cfg.pageTokenCap);
  const unassigned = new Set<NodeId>(index.nodes.keys());
  const adj = buildAdjacency(index);
  const pages: MutablePage[] = [];

  while (unassigned.size > 0) {
    const seed = pickSeed(unassigned, index);
    const pageNodes = new Set<NodeId>([seed]);
    let estCost = tokenCostForNode(index.nodes.get(seed)!);

    // Build frontier
    let frontier = new Set<NodeId>();
    for (const n of adj.get(seed) ?? []) if (unassigned.has(n)) frontier.add(n);

    while (frontier.size > 0) {
      // Pick best candidate
      let best: NodeId | null = null;
      let bestScore = -Infinity;
      for (const c of frontier) {
        const s = scoreCandidate(c, pageNodes, index);
        if (s > bestScore || (s === bestScore && best !== null && String(c) < String(best))) {
          best = c;
          bestScore = s;
        }
      }
      if (!best) break;

      const cNode = index.nodes.get(best)!;
      const nextCost = estCost + tokenCostForNode(cNode);
      if (nextCost > PAGE_TOKENS) break;

      // Accept candidate
      pageNodes.add(best);
      estCost = nextCost;
      unassigned.delete(best);

      // Update frontier
      for (const n of adj.get(best) ?? []) {
        if (!pageNodes.has(n) && unassigned.has(n)) frontier.add(n);
      }
      frontier.delete(best);
    }

    // Build edge splits
    const pageSet = pageNodes;
    const intra: Edge[] = [];
    const xref: Edge[] = [];
    for (const e of index.edges) {
      const inPageFrom = pageSet.has(e.from);
      const inPageTo = pageSet.has(e.to);
      if (inPageFrom && inPageTo) intra.push(e);
      else if (inPageFrom !== inPageTo) xref.push(e);
    }

    const pid = pageIdFor([...pageNodes]);
    pages.push({
      id: pid,
      nodes: [...pageNodes].sort((a, b) => (String(a) < String(b) ? -1 : 1)),
      edges: intra,
      xedges: xref,
      tokenCost: estCost + intra.length * tokenCostForEdge(intra[0] ?? ({} as Edge)),
      level: 0,
      hotness: 0,
    });

    // Mark all page nodes as assigned
    for (const n of pageNodes) unassigned.delete(n);
  }

  // Recompute precise tokenCost using renderer (optional)
  const nodeMap = new Map<string, Node>();
  for (const [id, n] of index.nodes) nodeMap.set(String(id), n);
  for (const p of pages) {
    p.tokenCost = estimateTokenCostForPage(p as Page, nodeMap);
  }

  // Convert to readonly pages
  return pages.map(p => ({
    id: p.id,
    nodes: Object.freeze([...p.nodes]),
    edges: Object.freeze([...p.edges]),
    xedges: Object.freeze([...p.xedges]),
    tokenCost: p.tokenCost,
    level: p.level,
    hotness: p.hotness,
  }));
}

// --------- Degradation ---------

export function degradePage(page: Page, toLevel: DegradationLevel): Page {
  if (toLevel < page.level) return page; // never upgrade here
  return { ...page, level: toLevel };
}

// --------- Hotness helpers (for a future cache) ---------

export function touchHotness(x: number): number {
  // EMA: new = 0.8*old + 0.2
  return clamp01(0.8 * x + 0.2);
}
