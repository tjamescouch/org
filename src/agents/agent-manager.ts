import { makeStreamingOpenAiLmStudio } from "../drivers/streaming-openai-lmstudio";
import { Agent } from "./agent";
import { LlmAgent } from "./llm-agent";
import { MockModel } from "./mock-model";

type ModelKind = "mock" | "lmstudio";
type AgentSpec = { id: string; kind: ModelKind; model: Agent };
type AgentCreator = (agentId: string, model: string, extra: string, defaults: LlmDefaults) => Promise<AgentSpec>;
type LlmDefaults =  { model: string; baseUrl: string; protocol: "openai"|"google"|"deepseek"|"antrhopic"; apiKey?: string };

const openaiModelCreationHandler = async (agentId: string, model: string, extra: string, defaults: LlmDefaults): Promise<AgentSpec> => {
    const driver = makeStreamingOpenAiLmStudio({
        baseUrl: defaults.baseUrl,
        model: defaults.model,
        //apiKey: defaults.apiKey
    });
    const agentModel = new LlmAgent(agentId, driver, defaults.model);
    await agentModel.load();

    return {
        id: agentId,
        kind: "lmstudio",
        model: agentModel,
    };
};

const gemmaModelCreationHandler = async (agentId: string, model: string, extra: string, defaults: LlmDefaults): Promise<AgentSpec> => {
    const driver = makeStreamingOpenAiLmStudio({ //Same for now
        baseUrl: defaults.baseUrl,
        model: defaults.model,
        //apiKey: defaults.apiKey
    });
    const agentModel = new LlmAgent(agentId, driver, defaults.model);
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
        ['ollama.openai']: openaiModelCreationHandler,
        ['lmstudio.openai']: openaiModelCreationHandler,
        ['lmstudio.gemma']: gemmaModelCreationHandler,
        ['ollama.gemma']: gemmaModelCreationHandler,
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
            const [id, kindRaw = "mock"] = item.split(":");
            const [kind, protocolRaw ]= ((kindRaw as ModelKind) || "ollama.openai").split(".");
            const protocol = protocolRaw || llmDefaults.protocol;

            const creationHandler = this.creationHandlers[kind + '.' + protocol];

            if (!creationHandler) {
                throw new Error('Unsupported model protocol');
            }

            if (llmDefaults.protocol !== "openai") throw new Error(`Unsupported protocol: ${llmDefaults.protocol}`);

            const model = llmDefaults.model;
            const agentSpec = await creationHandler(id, model, "", llmDefaults);
            const agentModel = agentSpec.model;

            if (recipeSystemPrompt && (agentModel as { setSystemPrompt?: (s: string) => void }).setSystemPrompt) {
                (agentModel as unknown as { setSystemPrompt: (s: string) => void }).setSystemPrompt(recipeSystemPrompt); //FIXME
            }

            out.push(agentSpec);
        }
        return out;
    }

    async saveAll(): Promise<void>  {
        for (const agent of this.agents) {
            agent.save();
        }
    }
}