// src/idsl/types.ts
// Type-safe core types + utility helpers for IDSL-α

export type NodeKind = "module" | "interface" | "fn" | "type" | "invariant" | "example";
export type Relation = "calls" | "imports" | "implements" | "depends_on" | "owns";

export type Branded<T, B extends string> = T & { readonly __brand: B };

export type NodeId = Branded<string, "NodeId">;
export type PageId = Branded<string, "PageId">;

export interface PathSpan {
  file: string;
  startLine: number; // 1-based
  endLine: number;   // inclusive
}

export interface NodeAttrs {
  readonly stability?: "stable" | "volatile" | "experimental";
  readonly churn?: "low" | "medium" | "high";
  readonly owners?: string[];
  readonly version?: number;
  readonly hash?: string;           // content/hash of definition if available
  readonly examples?: string[];     // short, 1-line examples
  // free-form extra keys (kept small)
  readonly extra?: Record<string, string | number | string[]>;
}

export interface NodeBase {
  id: NodeId;
  kind: NodeKind;
  name: string;        // e.g., "Store.add", "IStore"
  path?: PathSpan;
  attrs: NodeAttrs;
}

export type Node = NodeBase;

export interface Edge {
  from: NodeId;
  to: NodeId;
  rel: Relation;
}

export type DegradationLevel = 0 | 1 | 2 | 3;

export interface Page {
  id: PageId;
  nodes: ReadonlyArray<NodeId>;
  edges: ReadonlyArray<Edge>;   // intra-page edges
  xedges: ReadonlyArray<Edge>;  // cross-page edges (references to nodes outside this page)
  tokenCost: number;            // rough estimate for human DSL rendering
  level: DegradationLevel;      // 0 richest → 3 coarsest
  hotness: number;              // EMA of touches, 0..1
}

export interface IndexData {
  nodes: ReadonlyMap<NodeId, Node>;
  edges: ReadonlyArray<Edge>;
  // adjacency for quick graph traversal
  adjOut: ReadonlyMap<NodeId, ReadonlyArray<Edge>>;
  adjIn: ReadonlyMap<NodeId, ReadonlyArray<Edge>>;
}

export interface WorkingSet {
  pages: ReadonlyArray<Page>;
  slices: ReadonlyArray<PathSpan>;
  nodes: ReadonlyArray<NodeId>;
}

// ------------------- Utilities -------------------

export const AVG_CHARS_PER_TOKEN = 4;

export function makeNodeId(kind: NodeKind, name: string): NodeId {
  return (`${kind}:${name}`) as NodeId;
}

export function stableCompareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function estimateTokensFromChars(chars: number, avg: number = AVG_CHARS_PER_TOKEN): number {
  const c = Math.max(0, Math.floor(chars));
  const a = Math.max(1, Math.floor(avg));
  return Math.ceil(c / a);
}

export function pathSpanToString(p: PathSpan | undefined): string {
  if (!p) return "";
  return `${p.file}:${p.startLine}..${p.endLine}`;
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
