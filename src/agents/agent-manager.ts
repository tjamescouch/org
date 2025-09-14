import * as fs from "node:fs";
import * as path from "node:path";

import { makeStreamingOpenAiLmStudio } from "../drivers/streaming-openai-lmstudio";
import { Agent } from "./agent";
import { LlmAgent } from "./llm-agent";
import { MockModel } from "./mock-model";
import { R } from "../runtime/runtime";
import { Logger } from "../logger";

type ModelKind = "mock" | "lmstudio";
type AgentSpec = { id: string; kind: ModelKind; model: Agent };
type AgentCreator = (agentId: string, model: string, extra: string, defaults: LlmDefaults) => Promise<AgentSpec>;
type LlmDefaults = { model: string; baseUrl: string; protocol: "openai" | "google" | "deepseek" | "antrhopic"; apiKey?: string };

const openaiModelCreationHandler = async (agentId: string, model: string, extra: string, defaults: LlmDefaults): Promise<AgentSpec> => {
    Logger.info("openai", {agentId, model, extra, defaults});

    const driver = makeStreamingOpenAiLmStudio({
        baseUrl: defaults.baseUrl,
        model: model || defaults.model,
        //apiKey: defaults.apiKey
    });
    const agentModel = new LlmAgent(agentId, driver, model || defaults.model);
    await agentModel.load();

    return {
        id: agentId,
        kind: "lmstudio",
        model: agentModel,
    };
};

const gemmaModelCreationHandler = async (agentId: string, model: string, extra: string, defaults: LlmDefaults): Promise<AgentSpec> => {
    Logger.info("gemma", {agentId, model, extra, defaults});

    const driver = makeStreamingOpenAiLmStudio({ //Same for now
        baseUrl: defaults.baseUrl,
        model: model || defaults.model,
        //apiKey: defaults.apiKey
    });
    const agentModel = new LlmAgent(agentId, driver, model || defaults.model);
    await agentModel.load();

    return {
        id: agentId,
        kind: "lmstudio",
        model: agentModel,
    };
};

const mockModelCreationHanlder = async (agentId: string, model: string, extra: string, defaults: LlmDefaults): Promise<AgentSpec> => {
    const agentModel = new MockModel(agentId);
    return {
        id: agentId,
        kind: "mock",
        model: agentModel,
    };
};

export class AgentManger {
    private agents: Agent[] = [];

    private readonly creationHandlers: Record<string, AgentCreator> = {
        ['lmstudio.openai']: openaiModelCreationHandler,
        ['lmstudio.google']: gemmaModelCreationHandler,
        ['ollama.openai']: openaiModelCreationHandler,
        ['ollama.google']: gemmaModelCreationHandler,
        ['mock.mock']: mockModelCreationHanlder,
    };

    async parse(
        spec: string,
        llmDefaults: LlmDefaults,
        recipeSystemPrompt?: string | null
    ): Promise<AgentSpec[]> {
        const list = String(spec).split(",").map(x => x.trim()).filter(Boolean);
        const out: AgentSpec[] = [];
        for (const item of list) {


            // item is a single agent segment, e.g. "alice^lmstudio.openai^openai/gpt-oss-120b^##system-prompt.txt"
            const seg = item.trim();
            const partsRaw = seg.split("^");
            const parts = partsRaw.map(s => s.trim());

            // Enforce: id required; no empty placeholders allowed (no skipping fields).
            if (!parts[0] || parts.slice(1).some(p => p.length === 0)) {
                throw new Error(`[agents] invalid spec "${seg}". Do not skip fields; if you use defaults, stop there.`);
            }

            const id = parts[0];

            // driverKind[.protocol]
            type Protocol = LlmDefaults["protocol"];
            const protocols = ["openai", "google", "deepseek", "antrhopic"];
            const isProtocol = (p: string): p is Protocol => protocols.includes(p);

            type ModelKindStrict = "mock" | "lmstudio" | "ollama";
            const isModelKind = (k: string): k is ModelKindStrict => ["lmstudio", "ollama"].includes(k);

            let kind: ModelKindStrict = "lmstudio";
            let protocol: Protocol = llmDefaults.protocol;

            if (parts.length >= 2) {
                const [k, p] = parts[1].split(".", 2).map(s => s.trim());
                if (k) {
                    if (!isModelKind(k)) throw new Error(`[agents] unknown driver kind: ${k}`);
                    kind = k;
                }
                if (p) {
                    if (!isProtocol(p)) throw new Error(`[agents] unknown protocol: ${p}`);
                    protocol = p;
                }
            }

            // model
            let model = llmDefaults.model;
            if (parts.length >= 3) {
                model = parts[2];
            }

            // system prompt (inline or file via ##path)
            let systemPrompt: string | undefined;
            if (parts.length >= 4) {
                const pr = parts[3];
                systemPrompt = pr.startsWith("##")
                    ? fs.readFileSync(path.resolve(R.cwd(), pr.slice(2)), "utf8")
                    : pr;
            }

            // Create the agent using the resolved handler
            const handlerKey = `${kind}.${protocol}`;
            const creationHandler = this.creationHandlers[handlerKey];
            if (!creationHandler) {
                throw new Error(`[agents] no creation handler for "${handlerKey}"`);
            }

            const agentSpec = await creationHandler(id, model, "", llmDefaults);

            if (systemPrompt) {
                agentSpec.model.setSystemPrompt(systemPrompt);
            }

            const agentModel = agentSpec.model;

            if (recipeSystemPrompt && (agentModel as { setSystemPrompt?: (s: string) => void }).setSystemPrompt) {
                (agentModel as unknown as { setSystemPrompt: (s: string) => void }).setSystemPrompt(recipeSystemPrompt); //FIXME
            }

            out.push(agentSpec);
        }
        return out;
    }

    async saveAll(): Promise<void> {
        for (const agent of this.agents) {
            agent.save();
        }
    }
}