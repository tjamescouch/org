// src/metrics/run-metrics.ts
// Minimal, type-safe metrics events + JSONL logger + CLI summarizer.
// NEW: If no tool events exist, we heuristically estimate tool success by
// scraping .orgmemories/* for tool-role messages across ALL agents.
//
// Usage:
//   import { RunMetrics } from "../metrics/run-metrics";
//   await RunMetrics.emitStep({...});   // (A) per-turn hook
//   await RunMetrics.emitTool({...});   // (B) optional; if omitted, summarizer will estimate
// CLI:
//   bun tsx src/metrics/run-metrics.ts summarize [.org/metrics.jsonl]

import { promises as fs } from "fs";
import * as path from "path";

export type Iso8601 = string & { __brand: "Iso8601" };

export type StepEvent = {
  kind: "step";
  runId: string;
  turn: number;                   // monotonically increasing per session
  agent?: string | null;          // "alice"/"bob"/...
  phase?: string | null;          // optional, e.g., "QA" | "Plan" | "Surgery"
  headerTokens: number;           // tokens of head system message (P_t)
  totalTokens: number;            // tokens of [P_t, H_t]
  userVisibleReply?: string;      // ONLY the outward reply (omit debug/CoT)
  coherent?: boolean;             // optional: did this step advance plan w/o invariant breaks?
  personaVersion?: number;
  normativeVersion?: number;
  timestamp: Iso8601;
};

export type ToolEvent = {
  kind: "tool";
  runId: string;
  turn: number;
  tool: string;
  ok: boolean;                    // success/failure of the tool call
  timestamp: Iso8601;
};

export type PatchEvent = {
  kind: "patch";
  runId: string;
  turn: number;
  proposed: boolean;
  applied?: boolean;
  ok?: boolean;                   // true if applied cleanly and checks passed
  timestamp: Iso8601;
};

export type PolicyConflictEvent = {
  kind: "policy_conflict";
  runId: string;
  turn: number;
  baseDirective: string;          // short label, e.g., "concise"
  normDirective: string;          // e.g., "verbose"
  chosen: "base" | "norm" | "user" | "other";
  complied: boolean;              // did output match chosen?
  timestamp: Iso8601;
};

export type ProspectiveEvent = {
  kind: "prospective";
  runId: string;
  turn: number;
  action: "scheduled" | "fired";
  id: string;                     // your trigger id
  timestamp: Iso8601;
};

export type UserInterjectionEvent = {
  kind: "user_interjection";
  runId: string;
  turn: number;
  timestamp: Iso8601;
};

export type MetricEvent =
  | StepEvent
  | ToolEvent
  | PatchEvent
  | PolicyConflictEvent
  | ProspectiveEvent
  | UserInterjectionEvent;

function nowIso(): Iso8601 {
  return new Date().toISOString() as Iso8601;
}

function bool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isFinitePosInt(n: unknown): n is number {
  return Number.isFinite(n) && typeof n === "number" && n >= 0;
}

export class RunMetrics {
  private static filePath: string | null = null;

  /** Where to write JSONL. Defaults to ".org/metrics.jsonl" unless ORG_METRICS_FILE is set. */
  static async init(fileOverride?: string): Promise<void> {
    if (this.filePath) return;
    const p =
      fileOverride ||
      process.env.ORG_METRICS_FILE ||
      path.join(process.cwd(), ".org", "metrics.jsonl");
    await fs.mkdir(path.dirname(p), { recursive: true });
    this.filePath = p;
  }

  private static async write(ev: MetricEvent): Promise<void> {
    if (!this.filePath) await this.init();
    await fs.appendFile(this.filePath!, JSON.stringify(ev) + "\n", "utf8");
  }

  // ---- Emitters (call these from your code) ---------------------------------

  static async emitStep(e: Omit<StepEvent, "kind" | "timestamp">): Promise<void> {
    if (!isFinitePosInt(e.turn)) throw new Error("emitStep: invalid turn");
    if (!isFinitePosInt(e.headerTokens) || !isFinitePosInt(e.totalTokens))
      throw new Error("emitStep: invalid token counts");
    await this.write({ kind: "step", timestamp: nowIso(), ...e });
  }

  static async emitTool(e: Omit<ToolEvent, "kind" | "timestamp">): Promise<void> {
    await this.write({ kind: "tool", timestamp: nowIso(), ...e });
  }

  static async emitPatch(e: Omit<PatchEvent, "kind" | "timestamp">): Promise<void> {
    await this.write({ kind: "patch", timestamp: nowIso(), ...e });
  }

  static async emitPolicyConflict(
    e: Omit<PolicyConflictEvent, "kind" | "timestamp">
  ): Promise<void> {
    await this.write({ kind: "policy_conflict", timestamp: nowIso(), ...e });
  }

  static async emitProspective(
    e: Omit<ProspectiveEvent, "kind" | "timestamp">
  ): Promise<void> {
    await this.write({ kind: "prospective", timestamp: nowIso(), ...e });
  }

  static async emitUserInterjection(
    e: Omit<UserInterjectionEvent, "kind" | "timestamp">
  ): Promise<void> {
    await this.write({ kind: "user_interjection", timestamp: nowIso(), ...e });
  }

  // ---- Summarizer (optional CLI) -------------------------------------------

  static async summarize(file?: string): Promise<void> {
    const fp =
      file ||
      process.env.ORG_METRICS_FILE ||
      path.join(process.cwd(), ".org", "metrics.jsonl");

    const txt = await fs.readFile(fp, "utf8").catch(() => "");
    const lines = txt ? txt.split(/\r?\n/).filter(Boolean) : [];

    const steps: StepEvent[] = [];
    const tools: ToolEvent[] = [];
    const patches: PatchEvent[] = [];
    const conflicts: PolicyConflictEvent[] = [];
    const pros: ProspectiveEvent[] = [];
    const userInt: UserInterjectionEvent[] = [];

    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as MetricEvent;
        switch (ev.kind) {
          case "step": steps.push(ev); break;
          case "tool": tools.push(ev); break;
          case "patch": patches.push(ev); break;
          case "policy_conflict": conflicts.push(ev); break;
          case "prospective": pros.push(ev); break;
          case "user_interjection": userInt.push(ev); break;
        }
      } catch { /* ignore bad lines */ }
    }

    // ---- Core outcome: CSR & CSH (if coherent flags provided) ---------------
    const coherentFlags = steps.map(s => s.coherent).filter(bool);
    const csr = coherentFlags.length
      ? coherentFlags.reduce((a, b) => a + (b ? 1 : 0), 0) / coherentFlags.length
      : NaN;

    const csh = Number.isFinite(csr) && csr > 0 && csr < 1
      ? Math.log(0.5) / Math.log(csr)
      : NaN;

    // ---- Header share & planner-leak rate -----------------------------------
    const hsSamples = steps.filter(s => s.totalTokens > 0);
    const headerShare =
      hsSamples.length
        ? hsSamples.reduce((a, s) => a + s.headerTokens / s.totalTokens, 0) / hsSamples.length
        : NaN;

    const PLR_regex = /\b(?:Now produce final answer\.?|Thus final answer:?|Plan:|Two distinct lines)\b/i;
    const plrBase = steps.filter(s => typeof s.userVisibleReply === "string");
    const plr =
      plrBase.length
        ? plrBase.reduce((a, s) => a + (PLR_regex.test(s.userVisibleReply!) ? 1 : 0), 0) /
          plrBase.length
        : NaN;

    // ---- Tool success --------------------------------------------------------
    let toolSuccess: number = NaN;
    let toolSuccessNote = "";

    if (tools.length) {
      toolSuccess =
        tools.reduce((a, t) => a + (t.ok ? 1 : 0), 0) / tools.length;
      toolSuccessNote = "from emitted tool events";
    } else {
      // Fallback: estimate across ALL agents by scraping .orgmemories/*
      const est = await estimateToolSuccessFromOrgMemories(process.cwd());
      if (est) {
        const denom = est.ok + est.fail;
        toolSuccess = denom > 0 ? est.ok / denom : NaN;
        toolSuccessNote = denom > 0
          ? `est. from .orgmemories (${est.ok} ok, ${est.fail} fail, ${est.unknown} unknown)`
          : "no tool evidence in .orgmemories";
      }
    }

    // ---- Patch Apply Success (if you ever emit it) ---------------------------
    const patchProposed = patches.filter(p => p.proposed);
    const patchApplied = patchProposed.filter(p => p.applied === true);
    const patchOk =
      patchApplied.length
        ? patchApplied.reduce((a, p) => a + (p.ok ? 1 : 0), 0) / patchApplied.length
        : NaN;

    // ---- Intervention interval ----------------------------------------------
    const userTurns = userInt.map(u => u.turn).sort((a, b) => a - b);
    let intervals: number[] = [];
    for (let i = 1; i < userTurns.length; i++) intervals.push(userTurns[i] - userTurns[i - 1]);
    const medianIntervention = intervals.length
      ? intervals.sort((a, b) => a - b)[Math.floor((intervals.length - 1) / 2)]
      : NaN;

    // ---- IAC (needs explicit conflict events) --------------------------------
    const agree = conflicts.filter(c => c.baseDirective === c.normDirective);
    const conflict = conflicts.filter(c => c.baseDirective !== c.normDirective);

    const agreeCompliance =
      agree.length ? agree.reduce((a, c) => a + (c.complied ? 1 : 0), 0) / agree.length : NaN;

    const conflictComplianceNorm =
      conflict.length
        ? conflict
            .filter(c => c.chosen === "norm")
            .reduce((a, c) => a + (c.complied ? 1 : 0), 0) /
          Math.max(1, conflict.filter(c => c.chosen === "norm").length)
        : NaN;

    const IAC =
      Number.isFinite(agreeCompliance) && Number.isFinite(conflictComplianceNorm) && agreeCompliance > 0
        ? conflictComplianceNorm / agreeCompliance
        : NaN;

    // ---- Print scoreboard ----------------------------------------------------
    const fmt = (x: number) =>
      Number.isFinite(x) ? (Math.abs(x) >= 1 ? x.toFixed(2) : (x * 100).toFixed(1) + "%") : "—";

    console.log("\n=== org :: run metrics ===");
    console.log("steps:", steps.length, "tools:", tools.length, "patches:", patches.length);
    console.log("CSR:", fmt(csr), "   CSH(0.5):", fmt(csh));
    console.log("Header share:", fmt(headerShare), "   PLR:", fmt(plr));
    console.log("Tool success:", fmt(toolSuccess), toolSuccessNote ? `  (${toolSuccessNote})` : "");
    console.log("Patch ok:", fmt(patchOk), "   Intervention interval (median turns):", fmt(medianIntervention));
    console.log("IAC (Norm vs Base):", fmt(IAC));
    console.log("==========================\n");
  }
}

// ---- Heuristic tool estimator (no hooks; aggregates across ALL agents) -----

type ToolEst = { ok: number; fail: number; unknown: number };

async function estimateToolSuccessFromOrgMemories(root: string): Promise<ToolEst | null> {
  const dir = path.join(root, ".orgmemories");
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null; // no memory dir
  }
  files = files
    .filter(f => !f.startsWith(".") && !f.endsWith(".lock"))
    .map(f => path.join(dir, f));

  if (files.length === 0) return null;

  let ok = 0, fail = 0, unknown = 0;

  for (const fp of files) {
    let txt = "";
    try { txt = await fs.readFile(fp, "utf8"); } catch { continue; }
    let obj: any = null;
    try { obj = JSON.parse(txt); } catch { continue; }

    const buf = Array.isArray(obj?.messagesBuffer) ? obj.messagesBuffer : [];
    for (const m of buf) {
      if (!m || m.role !== "tool") continue;

      // Normalize content to string
      const cVal = (m as any).content;
      let content: string;
      if (typeof cVal === "string") content = cVal;
      else if (cVal != null) { try { content = JSON.stringify(cVal); } catch { content = String(cVal); } }
      else content = "";

      const verdict = classifyToolContent(content);
      if (verdict === "ok") ok++;
      else if (verdict === "fail") fail++;
      else unknown++;
    }
  }
  return { ok, fail, unknown };
}

type ToolOutcome = "ok" | "fail" | "unknown";
function classifyToolContent(s: string): ToolOutcome {
  const t = s || "";

  // Try strict JSON first
  try {
    const obj = JSON.parse(t);
    // Common fields in our tool envelopes
    if (obj && typeof obj === "object") {
      if (obj.ok === true || obj.success === true || obj.status === "ok" || obj.status === "success") return "ok";
      if (obj.ok === false || obj.success === false || obj.error != null) return "fail";
      if (Number.isFinite(obj.exitCode)) return obj.exitCode === 0 ? "ok" : "fail";
    }
  } catch { /* not JSON; fallthrough to regex */ }

  // Regex heuristics for raw logs
  if (/\b(exited?\s+with\s+code\s+0|exit\s*[:=]\s*0|exitCode\s*[:=]\s*0)\b/i.test(t)) return "ok";
  if (/\b(exit(?:ed)?\s+with\s+code\s+[1-9]\d*|exit\s*[:=]\*[1-9]\d*|exitCode\s*[:=]\s*[1-9]\d*)\b/i.test(t)) return "fail";
  if (/\b(error|exception|traceback|failed|non-zero exit)\b/i.test(t)) return "fail";

  // Unknown if nothing conclusive found
  return "unknown";
}

// ---- Simple CLI --------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const sub = process.argv[2];
    if (sub === "summarize") {
      const file = process.argv[3];
      await RunMetrics.summarize(file);
    } else {
      console.log("Usage: bun tsx src/metrics/run-metrics.ts summarize [.org/metrics.jsonl]");
    }
  })().catch(err => {
    console.error("[metrics] error:", err?.stack || String(err));
    process.exit(1);
  });
}
