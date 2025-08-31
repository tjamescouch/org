// src/scheduler/router.ts
import { makeRouter } from "../routing/route-with-tags";
import { Logger, C } from "../logger";
import { ExecutionGate } from "../tools/execution-gate";
import { FileWriter } from "../io/file-writer";
import { restoreStdin } from "../utils/restore-stdin";
import { finalizeAllSandboxes } from "../tools/sandboxed-sh";
import type { GuardDecision } from "../guardrails/guardrail";
import type { Responder } from "./types";
import type { ChatMessage } from "../types";
import { NoiseFilters } from "./filters";
import { ISandboxSession } from "../sandbox/types";
import { LockedDownFileWriter } from "../io/locked-down-file-writer";

/** Side-effects required by routing (DMs, group fanout, files, user prompts). */
export interface RouteDeps {
    /** Known agents (for lookup and fan-out). */
    agents: Responder[];
    /** Enqueue a message for an agent. */
    enqueue: (toId: string, msg: ChatMessage) => void;
    /** Provide the scheduler a hint who is likely to reply next. */
    setRespondingAgent: (id?: string) => void;
    /** Called when guardrails return a decision. */
    applyGuard: (from: Responder, dec: GuardDecision) => Promise<void>;
    /** Remember last agent that addressed @@user. */
    setLastUserDMTarget: (id: string) => void;
}

/**
 * Heuristic: detect a "talk to the human" request even if a model emitted `@user`
 * (single '@') or mixed case. We only accept it when it appears at the start
 * of a line (ignoring leading whitespace and an optional '>' quote marker),
 * to avoid false positives in email addresses etc.
 */
function looksLikeUserTag(text: string): boolean {
    if (/@{2}user\b/i.test(text)) return true; // canonical @@user anywhere
    const lines = String(text ?? "").split(/\r?\n/);
    for (const line of lines) {
        if (/^\s*>?\s*@user\b/i.test(line)) return true;
    }
    return false;
}

/**
 * Route a model message that may contain @@agent, @@group, @@user, ##file.
 * Returns true if the message contained a request to talk to the user.
 */
export async function routeWithSideEffects(
    deps: RouteDeps,
    fromAgent: Responder,
    text: string,
    filters: NoiseFilters,
    sandbox?: ISandboxSession,
): Promise<boolean> {
    const router = makeRouter({
        onAgent: async (_from, to, cleaned) => {
            deps.setRespondingAgent(to);
            //const cleaned = filters.cleanAgent(content);
            if (cleaned) deps.enqueue(to, { role: "user", from: fromAgent.id, content: cleaned });
        },
        onGroup: async (_from, cleaned) => {
            //const cleaned = filters.cleanGroup(content); //FIXME - need to scrub then route
            Logger.info('{cleaned,content}',{ cleaned, content });
            const peers = deps.agents.map(a => a.id);
            const dec = fromAgent.guardCheck?.("group", cleaned, peers) || null;
            if (dec) await deps.applyGuard(fromAgent, dec);
            if (dec?.suppressBroadcast) {
                Logger.debug(`suppress @@group from ${fromAgent.id}`);
                return;
            }
            for (const a of deps.agents) {
                if (a.id === fromAgent.id) continue;
                if (cleaned) deps.enqueue(a.id, { role: "user", from: fromAgent.id, content });
            }
        },
        onUser: async (_from, _content) => {
            // In non-interactive mode, an @@user tag should terminate cleanly
            if (!process.stdin.isTTY) {
                try { await finalizeAllSandboxes(); } catch (e) { Logger.error(e); }
                process.stdout.write("\n");
                process.exit(0);
            }
            deps.setLastUserDMTarget(fromAgent.id);
        },
        onFile: async (_from, name, content) => {
            const body = filters.cleanFile(content);           // after fallback fix above
            const rel = String(name || "").replace(/^\.\/+/, "");
            const bytes = Buffer.byteLength(body, "utf8");

            // Optional confirmation only when interactive
            if (process.stdin.isTTY) {
                const confirm = `${body}\n***** Write to file? [y/N] ${rel}\n`;
                const wasRaw = (process.stdin as any)?.isRaw;
                try {
                    if (wasRaw) (process.stdin as any).setRawMode(false);
                    await ExecutionGate.gate(confirm);
                } finally {
                    // restore only if we changed it
                    if (wasRaw) (process.stdin as any).setRawMode(true);
                }
            }

            const writer = sandbox ? new LockedDownFileWriter(sandbox, { maxBytes: 1_000_000 }) : new FileWriter();
            await writer.write(rel, body);

            Logger.info(C.magenta(`Written to /work/${rel} (${bytes} bytes)`));
        }
        ,
    },
        deps.agents);

    // Run the canonical router first.
    const outcome = await router(fromAgent.id, text || "");

    // Fallback: treat leading-line `@user` as `@@user` (case-insensitive).
    if (!outcome.yieldForUser && looksLikeUserTag(text)) {
        if (!process.stdin.isTTY) {
            try { await finalizeAllSandboxes(); } catch { }
            process.stdout.write("\n");
            process.exit(0);
        }
        deps.setLastUserDMTarget(fromAgent.id);
        return true;
    }

    return outcome.yieldForUser;
}
