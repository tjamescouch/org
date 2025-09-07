# Architectural Review of the "org" Agentic Dev Helper

---
## 1. High‑Level Overview
The repository implements a **CLI tool** (`org`) that lets AI agents act on a codebase while keeping a human in the loop.  It is written in TypeScript and targets both **Bun** and **Node.js**, providing a runtime abstraction layer to run seamlessly in either environment.

---
## 2. Core Modules & Their Responsibilities
| Directory | Key Files | Responsibility |
|-----------|------------|----------------|
| `src/app.ts` | Entry point, argument parsing, project‑root detection, TTY guard installation | Orchestrates the whole run: loads config, builds agents, creates scheduler and review manager, handles finalisation. |
| `src/runtime/` | `runtime.ts` | Detects runtime (Bun/Node), normalises process APIs, provides signal handling helpers (`R`). |
| `src/agents/` | `agent.ts`, `llm-agent.ts`, `mock-model.ts`, `system-prompt.ts` | Base abstract **Agent** class, concrete LLM‑backed agent, mock for tests. Handles guard‑rail integration and message formatting. |
| `src/drivers/` | `openai-lmstudio.ts`, `streaming-openai-lmstudio.ts` | Implements streaming OpenAI / LMStudio drivers used by `LlmAgent`. |
| `src/tools/` | `sh.ts`, `execution-gate.ts` | Definition of **tool** interface, safe execution wrapper (`ExecutionGate`) that limits tool usage and enforces sandbox policies. |
| `src/sandbox/` | `session.ts`, `policy.ts`, backends (`local.ts`, `podman.ts`, `mock.ts`) | Isolates command execution; supports local and Podman containers, applies glob‑based file‑system restrictions. |
| `src/guardrails/` | `advanced-guardrail.ts`, `guardrail.ts` | Provides per‑agent safety checks (loop detection, tool‑use limits, content validation). |
| `src/scheduler/` | `random-scheduler.ts`, `round-robin-scheduler.ts`, `review-manager.ts` | Decouples **task routing** from agents; decides which agent processes a message, handles idle fallback via guard rails. |
| `src/input/` | TTY adapters/controllers (`tty-controller.ts`, etc.) | Manages interactive vs raw terminal modes, passes user prompts to the scheduler and receives agent output. |
| `src/io/` | `file-writer.ts`, `locked-down-file-writer.ts` | Abstracted file‑write API that respects sandbox policies and creates **git patches** instead of direct writes. |
| `src/memory/` | Various memory implementations (`advanced-memory.ts`, `summary-memory.ts`, etc.) | Stores conversation context per agent, supports summarisation to keep token usage bounded. |
| `src/ui/` | Console & tmux front‑ends (`console/index.ts`, `tmux/*`) | Presents prompts, progress bars and patch diffs to the human operator. |
| `src/config/` | Config loading (`config.ts`, `paths.ts`) | Reads `.org` configuration files (runtime safety flags, allowed tools, etc.). |
| `src/review/` | `finalize-run.ts`, `patch-apply.ts` | After a run finishes, gathers generated patches from `.org/runs/<uuid>/session.patch`, optionally shows them to the user and applies via `git apply`. |

---
## 3. Execution Flow (Simplified)
1. **Startup** – `src/app.ts` parses CLI args, resolves the project root (`git rev-parse --show-toplevel` fallback), loads configuration.
2. **Signal Guard** – Installs a TTY guard that ensures proper cleanup on SIGINT/SIGTERM/uncaught exceptions.
3. **Agent Construction** – `parseAgents()` builds an array of `AgentSpec`. For `lmstudio` agents it creates a streaming driver and wraps it in `LlmAgent`; for `mock` it uses `MockModel`.
4. **Scheduler Creation** – A scheduler (default random) is instantiated together with a `ReviewManager` that will later collect patches.
5. **Execution Gate Setup** – Configures safe mode, interactive flag and optional tool whitelist.
6. **Input Loop** – The `TtyController` reads user prompts (`withCookedTTY`) and forwards them to the scheduler via the routing layer (`route-with-tags.ts`).
7. **Agent Processing** – An agent receives a batch of `ChatMessage`s, runs its guard rail (`guardCheck`), may call tools (e.g., `sh`, `sandboxed‑sh`). Tool calls go through `ExecutionGate` → `SandboxSession` → the chosen backend.
8. **File Changes** – All writes are funneled through `LockedDownFileWriter`, which records an *atomic git patch* (`session.patch`) under `.org/runs/<run-id>/`. No file is modified on disk until a human approves.
9. **Review Phase** – When the run ends (or on user request), `finalizeOnce()` collects recent patches, presents them via pager or auto‑applies depending on `reviewMode` (`ask|auto|never`).
10. **Cleanup** – Scheduler drains, sandbox sessions finalize, and the process exits with a proper code.

---
## 4. Safety & Guardrails
- **GuardRail (AdvancedGuardRail)**: monitors loops, tool‑use count, content policy violations; can inject idle fallback messages.
- **ExecutionGate**: central point that decides whether a tool call is allowed (`safe` mode disables all tools unless whitelisted via `allowTools`).
- **Sandbox Policies**: defined in `src/sandbox/policy.ts`; restricts filesystem access using glob patterns, optionally disables network for podman backend.
- **Locked‑Down File Writer**: writes only inside the repository and records changes as patches; prevents accidental overwrites of unrelated files.
- **Review Manager**: forces a human decision before any patch is applied (`reviewMode="ask"` by default). This provides an explicit audit step.

---
## 5. Extensibility Points
| Feature | How to Extend |
|---------|---------------|
| New Agent Types | Subclass `Agent`, implement `respond()`; optionally provide a custom guard rail. |
| Additional LLM Drivers | Implement the streaming driver interface in `src/drivers/` and plug it into `parseAgents()`. |
| Custom Tools | Add a file under `src/tools/` exposing a `Tool` class, register it with `ExecutionGate.configure({ allowTools })`. |
| Scheduler Strategies | Implement `IScheduler` (or extend existing ones) and pass the instance to `ReviewManager`. |
| UI Front‑ends | Create a new module under `src/ui/` that implements the same console API used by `console/index.ts`. |

---
## 6. Observations & Recommendations
1. **Strong Separation of Concerns** – The codebase cleanly isolates runtime, sandboxing, agent logic, scheduling and UI. This makes reasoning about each piece easier.
2. **Safety First Design** – Guard rails, execution gate, sandbox, and patch‑review loop together provide a robust safety net; however the default config should clearly document which tools are enabled for typical use cases to avoid confusion.
3. **Documentation Gap** – While `README.md` explains high‑level concepts, there is limited cross‑reference between the docs and concrete modules (e.g., mapping “tool execution” in docs to `src/tools/`). Adding a small architecture diagram or module map would help newcomers.
4. **Memory Implementations** – Multiple memory strategies (`AdvancedMemory`, `SummaryMemory`, `ContextLimitedSummaryMemory`) have overlapping responsibilities; consider consolidating into a single configurable class to reduce maintenance overhead.
5. **Testing Coverage** – Core flow (scheduler → agent → sandbox) has few integration tests. Adding end‑to‑end tests that simulate a full run with a mock LLM would increase confidence in future changes.
6. **Configuration Validation** – At startup, the system loads config but does not validate fields (e.g., allowed tool list). Introducing schema validation (via `zod` or similar) could catch user errors early.
7. **Performance Considerations** – Each tool call spawns a new process in the sandbox; for high‑frequency operations (e.g., many small file writes) batching could improve speed.

---
## 7. Summary of Findings
- The project is well‑architected with clear module boundaries and a solid safety model.
- Core components interact via well‑defined interfaces: runtime abstraction → scheduler → agents → tools → sandbox → review.
- Extensibility is straightforward; adding new agents, drivers or UI front‑ends requires implementing existing abstract classes.
- Minor improvements around documentation, memory consolidation, config validation and broader integration testing would raise the overall quality.

---
*Generated by alice (AI assistant) on $(date)*
