

# 🚨 org is intended to be run in a VM that talks to LMStudio/Ollama running on the host. If you run this on your host, be sure to run in safe mode. 🚨

---

# org – Minimal Multi‑Agent Orchestrator (LM Studio + Tools)

A small, readable, and **extensible** multi‑agent orchestrator that:

* does **round‑robin** scheduling across agents,
* lets agents **call tools** (starting with a safe `sh` tool),
* uses a clean **driver** abstraction (currently **OpenAI‑compatible** → **LM Studio**),
* routes assistant messages using a simple, **extensible TagParser** (`@alice`, `@group`, `#notes.txt …`),
* avoids monkey‑patching and keeps classes **focused** (single responsibility).

The goal is to provide a simple, production‑lean codebase you can **reason about** and **extend** quickly.

---

## Contents

* [Quick Start](#quick-start)
* [Configuration](#configuration)
* [Running](#running)
* [How It Works](#how-it-works)
* [Tags & Routing](#tags--routing)
* [Tools (Function Calling)](#tools-function-calling)
* [Safe Execution](#safe-execution)
* [Extending the System](#extending-the-system)
* [Project Structure](#project-structure)
* [Troubleshooting](#troubleshooting)
* [FAQ](#faq)
* [License](#license)

---

## Quick Start

### Requirements

* **Bun** ≥ 1.0 (recommended) – runs TypeScript directly
  or **Node.js** ≥ 18 + your preferred TS runtime (e.g. `tsx`).

### LM Studio

* Install and run [LM Studio](https://lmstudio.ai/).
* Ensure the **OpenAI‑compatible** API is enabled and listening.
* Default base URL used by this project: `http://192.168.56.1:11434`
  (override via `LLM_BASE_URL` or `--base-url`).

### Install deps

This project purposely has minimal runtime deps. If you add drivers/tools that need packages, install them here:

```bash
bun install
# or
npm install
```

---

## Configuration

You can configure via **CLI flags** or **environment variables**.

### Environment Variables

| Variable       | Default                     | Description                                        |
| -------------- | --------------------------- | -------------------------------------------------- |
| `LLM_DRIVER`   | `lmstudio`                  | Driver key. Currently only `lmstudio`.             |
| `LLM_PROTOCOL` | `openai`                    | Protocol / wire-format. Currently `openai`.        |
| `LLM_BASE_URL` | `http://192.168.56.1:11434` | Base URL of LM Studio API (`/v1/chat/completions`) |
| `LLM_MODEL`    | `gpt-oss-120b`               | Model id to request from LM Studio                 |
| `SAFE_MODE`    | *(unset → false)*           | `1/true/yes` enables confirmation for `sh` tool    |

Example:

```bash
export LLM_BASE_URL="http://127.0.0.1:11434"
export LLM_MODEL="gpt-oss-120b"
export SAFE_MODE=true
```

### CLI Flags

| Flag          | Example                              | Meaning                               |
| ------------- | ------------------------------------ | ------------------------------------- |
| `--agents`    | `--agents "alice:lmstudio,bob:mock"` | Comma‑separated agents: `name:kind`   |
| `--max-tools` | `--max-tools 2`                      | Per‑turn tool budget per agent        |
| `--driver`    | `--driver lmstudio`                  | Driver key (same as `LLM_DRIVER`)     |
| `--protocol`  | `--protocol openai`                  | Protocol key (same as `LLM_PROTOCOL`) |
| `--base-url`  | `--base-url http://127.0.0.1:11434`  | Base URL override                     |
| `--model`     | `--model gpt-oss-120b`                | Model override                        |
| `--safe`      | `--safe`                             | Enable confirmation for `sh` tool     |

---

## Running

### With Bun (recommended)

```bash
bun run src/app.ts --agents "alice:lmstudio,bob:mock" --max-tools 2 --safe
```

### With Node (using tsx)

```bash
npm i -D tsx
node --loader tsx src/app.ts --agents "alice:lmstudio,bob:mock" --max-tools 2 --safe
```

You’ll be prompted:

```
Prompt> Build a tiny README and list current dir
```

The orchestrator will:

1. Broadcast the user prompt to agents (others appear as **role:"user"** to each agent).
2. **Round‑robin** schedule the agents.
3. Allow each agent up to **N tool calls** per turn (N = `--max-tools`).
4. As soon as an agent returns plain assistant text (no tools), it **yields**.

The loop exits after **two idle rounds** (no work & no pending messages).
Press **Ctrl+C** any time to quit.

---

## How It Works

### Drivers

Located in `src/drivers/`.

* **`openai-lmstudio.ts`** — a minimal driver that speaks **OpenAI Chat Completions** to **LM Studio**:

  * POSTs to `POST {base}/v1/chat/completions`
  * Accepts `tools` + `tool_choice:"auto"`
  * Returns `{ text, toolCalls }`

Driver interface (see `src/drivers/types.ts`):

```ts
export interface ChatDriver {
  chat(messages: ChatMessage[], opts?: { model?: string; tools?: any[] }): Promise<ChatOutput>;
}
```

### Agents

Located in `src/agents/`.

* **`llm-agent.ts`** — keeps its own minimal message history, adds a **system prompt** with instructions for the `sh` tool, calls the driver, executes tool calls (via `sh`), and pushes back **role:"tool"** results (with `tool_call_id`) to the model before yielding.
* **`mock-model.ts`** — a trivial baseline model (useful for smoke tests while bringing up drivers).

### Orchestrator

`src/app.ts`:

* Parses CLI + env (`src/config.ts`),
* Builds the agents from `--agents` (e.g. `alice:lmstudio,bob:mock`),
* Runs round‑robin with a **per‑turn tool budget** (`--max-tools`),
* Routes messages using the **TagParser** + **router**,
* Exits after two idle rounds.

---

## Tags & Routing

Agents are encouraged to structure their messages with simple tags:

* `@bob <message…>` — **direct message** to `bob`
* `@group <message…>` — **broadcast**
* `#notes.txt <content lines…>` — file “attachment” (by default we print; you can hook this to write the file if desired)

Example:

```
@david here are the documents
@robert did you get that thing I sent you? #blob.txt This is an awesome
file I made for you.
@group what are we all thinking?
```

The **TagParser** splits this into parts, and the router **delivers** them:

* `@<agent>` → goes to that agent’s inbox (others do not see it),
* `@group` → broadcast to all other agents,
* `#<path>` → routed to `onFile(from, filename, content)` (default prints; easy to persist).

> In each agent’s internal view, **other agents appear as role:"user"**. This arrangement keeps the tool‑calling logic simple and mirrors how most OpenAI‑style agentic systems work.

---

## Tools (Function Calling)

Tools live in `src/tools/`.

### `sh` Tool

* **Schema** (`SH_TOOL_DEF`):

  ```ts
  {
    type: "function",
    function: {
      name: "sh",
      description: "Run a POSIX shell command and return machine-readable stdout/stderr/exit_code.",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false
      }
    }
  }
  ```
* **Execution** (`runSh(cmd: string)`):

  * Uses **Bun.spawn** if available, else **Node child\_process.spawn**.
  * Returns `{ ok, stdout, stderr, exit_code, cmd }`.
  * Prints in **red**:

    ```
    sh: <cmd> -> <stdout and/or stderr trimmed>
    ```
* The LLM agent feeds tool results back to the driver as **role:"tool"** with the **original `tool_call_id`**, allowing the model to continue reasoning with the returned JSON.

---

## Safe Execution

The **ExecutionGate** (`src/tools/exec-gate.ts`) controls whether shell commands run without confirmation.

Configure at app start:

```ts
import { ExecutionGate } from "./tools/exec-gate";
ExecutionGate.configure({ safe: true /* or false */ });
```

Ways to enable **safe mode**:

* CLI: `--safe`
* Env: `SAFE_MODE=true` (or `1`, or `yes`)

In safe mode, the user is prompted:

```
Run: ls -la? [y/N]
```

You can inject custom **guards** (e.g., deny `rm -rf /`):

```ts
import { ExecutionGate, ExecutionGuard } from "./tools/exec-gate";

class NoDangerousRm extends ExecutionGuard {
  async allow(cmd: string) {
    return !/rm\s+-rf\s+\/\b/.test(cmd);
  }
}

ExecutionGate.configure({ safe: true, guards: [new NoDangerousRm()] });
```

---

## Extending the System

### Add a Driver

Create `src/drivers/my-driver.ts` implementing `ChatDriver`. Wire it in `src/app.ts`’s `parseAgents()`.

### Add a Tool

Create a `<tool>.ts` exporting:

* A **tool schema** matching OpenAI “function calling”
* A runner function that returns structured JSON
  Register it in `llm-agent.ts` (the `tools` array), and handle it in the tool loop.

### Customize Routing / File Writes

`src/app_support/route-with-tags.ts` and the in‑app `router` are purposely small:

* Replace the `onFile(from, filename, content)` handler to **persist** files,
* Extend TagParser to support additional tags.

---

## Project Structure

```
src/
  app.ts                      # Entry point & round‑robin loop
  config.ts                   # CLI + env config
  agents/
    llm-agent.ts              # LLM-backed agent (OpenAI tools loop)
    mock-model.ts             # Simple mock agent (no network)
  drivers/
    types.ts                  # ChatDriver interfaces
    openai-lmstudio.ts        # OpenAI-compatible driver to LM Studio
  tools/
    exec-gate.ts              # Safe execution gate + guards
    sh.ts                     # POSIX shell tool (Bun/Node portable)
  app_support/
    route-with-tags.ts        # Router using TagParser parts
  utils/
    tag-parser.ts             # TagParser used by the router
```

> If you don’t see some of these files, bring your repo up to the latest patch level you applied in this session.

---

## Troubleshooting

**No output from LM Studio**

* Check `LLM_BASE_URL` and that LM Studio is listening on `/v1/chat/completions`.
* Try:

  ```bash
  curl -s http://127.0.0.1:11434/v1/models
  ```

  and confirm the model name (`LLM_MODEL`) exists.

**Model never calls tools**

* Ensure the driver payload includes `tools` and `tool_choice:"auto"` (already implemented).
* Set a prompt that naturally requires a shell call (e.g., “list the current directory and show the first 5 files”).

**Tool results ignored**

* The agent must push tool outputs with `role:"tool"` **and** `tool_call_id` (already implemented). Verify in logs.

**Safe mode blocks everything**

* You enabled `--safe` or `SAFE_MODE=true`. Press **`y`** when prompted or run with `--safe 0`.

**Round‑robin stops too early**

* The loop exits after **two idle rounds** (no tool calls and no pending messages). If your agents keep quiet after a single response, this is expected. Increase `--max-tools` or adjust prompts.

---

## FAQ

**Why do other agents appear as `role:"user"` to each agent?**
It simplifies alignment with the OpenAI tool‑calling format and avoids coercing assistant/assistant threads. It also keeps your system prompt simple.

**Where does the `#filename` content go?**
By default, the router prints it. Replace the `onFile()` handler to persist to disk (e.g., `fs.writeFile`) with your policies/guards.

**Does the `sh` tool stream output?**
Not yet — the runner returns aggregated stdout/stderr when the process exits. The JSON design is compatible with streaming, so adding a streaming driver later is straightforward.

---

## License

MIT

---

### Credits

This repo aims to be a **clear, minimal** foundation for multi‑agent, tool‑using workflows with an LM Studio backend — with **strong separation of concerns** and **predictable behavior**.
