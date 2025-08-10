# org

A command-line tool for orchestrating a **group of LLMs** with tool-calling, safe execution inside a VM, and a simple “candidate vs current” workflow driven by Git.

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

- **Chat Completions + Tools**: Uses Ollama's `/v1/chat/completions` with streaming and OpenAI-style tools.
- **Shell & Python tools**:  
  - `sh` — run POSIX commands inside the VM (Bun spawn).  
  - `python_run` — execute Python snippets with a timeout (Bun spawn).
- **AgentModel**: Can switch **chat modes** via tool (`chat_mode` → `group` / `direct:<model>` / `file:<path>`), and call `sh`.
- **PythonModel**: Uses tool calls to run Python, consumes tool output internally, responds with summarized results.
- **Robust tool parsing**: `runWithTools` executes **declared** and **embedded** tool calls in the **same turn**.
- **Streaming**: `chatOnce(stream:true)` accumulates SSE deltas to bypass Ollama's 5-minute non-streaming timeout.
- **Concurrency control**: `ChannelLock` to serialize critical sections.
- **Safe runtime**: Runs in a VM with host-only access to Ollama; optional egress blocking with `ufw`.
- **Candidate testing**: Run **current** and **candidate** generations concurrently; promote via Git **merge** and rollback via **git revert**.

## Architecture

```
/org
├─ main.ts                 # boots the chat room / registers models
├─ chat.ts                 # chatOnce(streaming), runWithTools, types
├─ agent-model.ts          # AgentModel: sh, chat_mode, audience routing
├─ python-model.ts         # PythonModel: python_run tool (Bun-native)
├─ model.ts                # base Model interface + RoomMessage, hooks
├─ simple-context-model.ts # minimal context-preserving model
├─ extract-tool-calls.ts   # extractor for embedded "tool_calls"
├─ channel-lock.ts         # ChannelLock (dependency-free)
├─ ops/
│  ├─ run.sh               # start in tmux
│  ├─ stop.sh              # stop tmux session
│  ├─ start-current.sh     # checkout main, run on :7001
│  ├─ start-candidate.sh   # branch cand/<ts>, run on :7002
│  ├─ fitness.sh           # candidate fitness gate
│  ├─ promote.sh           # merge cand → main, tag, restart current
│  └─ rollback.sh          # revert last promote merge
└─ README.md
```

## Requirements

- **VM guest**: Debian 12 (ARM64) or similar, **Bun v1.2+**, `python3`, `tmux`, `git`, `curl`.
- **Host**: Ollama ≥ 0.11 listening on host-only IP.

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
2. Streaming deltas are stitched until `[DONE]`.
3. `runWithTools`:
   - Reads model's `tool_calls`.
   - Parses embedded tool calls from text.
   - Executes all tools in sequence.
   - Appends results to the conversation.

This ensures tags and tool calls in the same turn are processed.

## Models

### AgentModel

- Tools:
  - `sh(cmd, timeout_s)`
  - `chat_mode(mode)` → `group`, `direct:<modelId>`, or `file:<path>`
- Keeps raw tool output hidden unless explicitly requested.

### PythonModel

- Tool:
  - `python_run(code, timeout_s)`
- Summarizes output for the user, keeps raw data internal.

## Concurrency

`ChannelLock` provides a simple async lock:

```ts
const release = await lock.waitForLock(10000);
try {
  // critical section
} finally {
  release();
}
```

## Streaming to Console

**Bun:**

```ts
if (delta.content) Bun.stdout.write(delta.content);
```

**Node:**

```ts
if (delta.content) process.stdout.write(delta.content);
```

## Candidate vs Current Workflow

Run both generations side-by-side in the VM.

Start **current** (main branch) on port 7001:

```bash
./ops/start-current.sh
```

Start **candidate** (branch `cand/<timestamp>`) on port 7002:

```bash
./ops/start-candidate.sh
```

Test candidate fitness:

```bash
./ops/fitness.sh 7002
```

Promote candidate to current:

```bash
./ops/promote.sh
```

Rollback last promotion:

```bash
./ops/rollback.sh
```

## Security in VM

- Host-only network adapter only.
- Bind Ollama to host-only IP.
- Optionally block all outgoing traffic except to host Ollama:

```bash
sudo ufw --force reset
sudo ufw default deny outgoing
sudo ufw allow out to 192.168.56.1 port 11434 proto tcp
sudo ufw enable
```

## Troubleshooting

- **Timeouts**: Always use `stream:true` and disable Bun's fetch timeout.
- **Missing tool calls**: Check `finish_reason` and embedded extraction.
- **Race conditions**: Use `ChannelLock` for critical sections.

## License

MIT
