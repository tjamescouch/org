// src/idsl/jsonl.ts
// JSONL authority loader/writer + adjacency builder

import {
  Edge, IndexData, Node, NodeId, NodeKind, Relation, makeNodeId,
  Page, PathSpan, stableCompareStrings
} from "./types";

type JsonNode = {
  type: NodeKind;
  name: string;
  path?: string; // "file:start..end"
  attrs?: Record<string, unknown>;
};

type JsonEdge = {
  type: "edge";
  rel: Relation;
  from: string; // "kind:name" or just "name" (we'll normalize)
  to: string;
};

export function parsePathSpan(s?: string): PathSpan | undefined {
  if (!s) return undefined;
  const m = s.match(/^(.+):(\d+)\.\.(\d+)$/);
  if (!m) return undefined;
  return { file: m[1], startLine: Number(m[2]), endLine: Number(m[3]) };
}

export function normalizeNode(n: JsonNode): Node {
  const kid = n.type;
  const name = n.name;
  if (!kid || !name) throw new Error(`Invalid node: ${JSON.stringify(n)}`);
  const id = makeNodeId(kid, name);
  const attrs = normalizeAttrs(n.attrs);
  const path = parsePathSpan(n.path);
  return { id, kind: kid, name, path, attrs };
}

function normalizeAttrs(a?: Record<string, unknown>) {
  if (!a) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number") out[k] = v;
    else if (Array.isArray(v) && v.every(x => typeof x === "string")) out[k] = v.slice();
  }
  return out;
}

export function normalizeEdge(e: JsonEdge): Edge {
  if (e.type !== "edge") throw new Error(`Invalid edge record (type): ${JSON.stringify(e)}`);
  const rel: Relation = e.rel;
  if (!rel) throw new Error(`Invalid edge record (rel): ${JSON.stringify(e)}`);
  const from = normalizeRefToNodeId(e.from);
  const to = normalizeRefToNodeId(e.to);
  return { from, to, rel };
}

function normalizeRefToNodeId(ref: string): NodeId {
  // Accept "kind:name" or just "name" (assume "fn" if ambiguous)
  const m = ref.match(/^([a-z_]+):(.*)$/i);
  if (m) return (`${m[1]}:${m[2]}`) as NodeId;
  return (`fn:${ref}`) as NodeId;
}

export function loadJsonl(text: string): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/\r?\n/g)) {
    const line = raw.trim();
    if (!line) continue;
    const obj = JSON.parse(line) as Record<string, unknown>;
    const type = String(obj["type"] ?? "");

    if (type === "edge") {
      const e = normalizeEdge(obj as JsonEdge);
      edges.push(e);
      continue;
    }

    const node: JsonNode = {
      type: type as any,
      name: String(obj["name"] ?? ""),
      path: typeof obj["path"] === "string" ? (obj["path"] as string) : undefined,
      attrs: (obj["attrs"] as Record<string, unknown> | undefined),
    };
    const n = normalizeNode(node);
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    nodes.push(n);
  }

  nodes.sort((a, b) => stableCompareStrings(a.id, b.id));
  return { nodes, edges };
}

export function buildIndex(nodes: Node[], edges: Edge[]): IndexData {
  const map = new Map<NodeId, Node>();
  for (const n of nodes) map.set(n.id, n);

  const adjOut = new Map<NodeId, Edge[]>();
  const adjIn = new Map<NodeId, Edge[]>();
  for (const n of nodes) {
    adjOut.set(n.id, []);
    adjIn.set(n.id, []);
  }
  for (const e of edges) {
    if (!map.has(e.from) || !map.has(e.to)) continue; // skip dangling
    adjOut.get(e.from)!.push(e);
    adjIn.get(e.to)!.push(e);
  }
  // sort for determinism
  for (const arr of adjOut.values()) arr.sort((x, y) => stableCompareStrings(x.to, y.to));
  for (const arr of adjIn.values()) arr.sort((x, y) => stableCompareStrings(x.from, y.from));

  return { nodes: map, edges, adjOut, adjIn };
}
