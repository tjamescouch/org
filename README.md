# org

A command-line tool for orchestrating a group of LLMs with tool-calling, execution inside a VM, and a workflow driven by Git.

## Table of Contents
- [Highlights](#highlights)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Configuration](#configuration)
- [Install & Run (Developer)](#install--run-developer)
- [Tool Calling Flow](#tool-calling-flow)
- [Models](#models)
  - [AgentModel](#agentmodel)
  - [PythonModel](#pythonmodel)
- [Concurrency](#concurrency)
- [Streaming to Console](#streaming-to-console)
- [Candidate vs Current Workflow](#candidate-vs-current-workflow)
- [Security in VM](#security-in-vm)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Highlights

- Chat completions with tool-calling using Ollama’s `/v1/chat/completions` endpoint with streaming support.
- Tools available:
  - `sh` — run POSIX commands inside the VM (Bun spawn).
  - `python_run` — execute Python snippets with a timeout (Bun spawn).
- AgentModel supports switching chat modes via the `chat_mode` tool (`group`, `direct:<model>`, or `file:<path>`).
- PythonModel runs Python code via tool calls and summarizes output internally.
- Personas and per-persona models can be specified via command line arguments.
- Tool calls declared in the model response and embedded tool calls in the text are both executed within the same turn.
- Streaming accumulates SSE deltas to handle Ollama’s non-streaming timeout.
- Concurrency control is provided by `ChannelLock` to serialize critical sections.
- Execution occurs inside a VM with host-only network access; optional egress blocking is configurable.
- Banners and logging output are displayed as white on black text, flowing inline with the conversation.

## Architecture

```
/org
├─ main.ts                 # initializes chat room, registers models, parses CLI for personas/models
├─ chat.ts                 # handles chatOnce (streaming), runWithTools, and types
├─ agent-model.ts          # AgentModel: sh, chat_mode tool, routing logic
├─ python-model.ts         # PythonModel: python_run tool execution
├─ model.ts                # base Model interface, RoomMessage, hooks
├─ simple-context-model.ts # minimal context-preserving model implementation
├─ extract-tool-calls.ts   # extracts embedded tool calls from text
├─ channel-lock.ts         # provides ChannelLock for concurrency control
├─ ops/
│  ├─ run.sh               # start in tmux
│  ├─ stop.sh              # stop tmux session
│  ├─ start-current.sh     # checkout main, run on :7001
│  ├─ start-candidate.sh   # branch cand/<ts>, run on :7002
│  ├─ fitness.sh           # candidate fitness gate
│  ├─ promote.sh           # merge candidate → main, tag, restart current
│  └─ rollback.sh          # revert last promote merge
└─ README.md
```

## Requirements

- VM guest: Debian 12 (ARM64) or similar, Bun v1.2+, python3, tmux, git, curl.
- Host: Ollama ≥ 0.11 listening on a host-only IP.

Example host command:

```bash
export OLLAMA_HOST="http://192.168.56.1:11434"
ollama serve
```

## Configuration

Inside the VM:

```bash
export OLLAMA_BASE="http://192.168.56.1:11434"
export OLLAMA_MODEL="gpt-oss:120b"
```

If Node types are needed:

```bash
bun add -d bun-types @types/node
```

## Install & Run (Developer)

```bash
bun install
bun run main.ts
```

## Tool Calling Flow

1. `chatOnce` posts to `/v1/chat/completions` with `stream:true`.
2. Streaming deltas are collected until completion.
3. `runWithTools`:
   - Reads the model’s declared `tool_calls`.
   - Parses embedded tool calls from the response text.
   - Executes all tools sequentially.
   - Appends tool outputs back into the conversation.

This process ensures both declared and embedded tool calls are handled within the same turn.

## Models

### AgentModel

- Tools:
  - `sh(command, timeout_s)`
  - `chat_mode(mode)` — modes include `group`, `direct:<modelId>`, or `file:<path>`
- Tool outputs are not shown by default unless requested.

### PythonModel

- Tool:
  - `python_run(code, timeout_s)`
- Processes Python code execution internally and returns summarized results.

## Concurrency

`ChannelLock` provides a simple async lock for serializing critical sections:

```ts
const release = await lock.waitForLock(10000);
try {
  // critical section
} finally {
  release();
}
```

## Streaming to Console

Output from streaming responses and banners is displayed as white text on a black background, flowing inline with conversation content.

**Bun:**

```ts
if (delta.content) Bun.stdout.write(delta.content);
```

**Node:**

```ts
if (delta.content) process.stdout.write(delta.content);
```

## Security in VM

- VM uses a host-only network adapter.
- Ollama is bound to the host-only IP.
- Optional firewall rules can restrict outbound traffic except to the Ollama host:

```bash
sudo ufw --force reset
sudo ufw default deny outgoing
sudo ufw allow out to 192.168.56.1 port 11434 proto tcp
sudo ufw enable
```

## Troubleshooting

- Use `stream:true` to avoid Ollama’s fetch timeout.
- Verify tool calls are correctly detected via `finish_reason` and embedded extraction.
- Use `ChannelLock` to prevent race conditions in critical sections.

## License

MIT
