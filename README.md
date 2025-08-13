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

# org

*A small CLI that orchestrates a group of LLM “agents” with tool‑calling inside a VM, a turn‑based scheduler, and clean streaming to the terminal.*

---

## Table of Contents
- [Highlights](#highlights)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Interactive vs Script Mode](#interactive-vs-script-mode)
- [Personas & Models (CLI)](#personas--models-cli)
- [Turn Manager](#turn-manager)
- [Tool Calling](#tool-calling)
- [Streaming & Console Output](#streaming--console-output)
- [Security in the VM](#security-in-the-vm)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Highlights

- **OpenAI‑compatible chat streaming** (`/v1/chat/completions`) with SSE parsing.
- **Turn‑based scheduling**: a round‑robin **Turn Manager** prevents agent dog‑piling and adds proactive “tick” turns so the system stays responsive.
- **Inline tools**:
  - `sh` — run POSIX commands inside the VM (Bun spawn)
  - `python_run` — run small Python snippets with a timeout
- **Interjections**: press `i` to pause agents, type a message, and resume the round; `s` for a system message; `q`/`Ctrl+C` to quit.
- **Readable terminal output**: timestamps, colors, normalized line endings, and a periodic white‑on‑black banner that scrolls with content.
- **Personas**: choose which agents to start and which model each should use via CLI flags.

---

## Architecture

```
/org
├─ main.ts                 # entry point: TUI, CLI parsing, interject controls, scheduler bootstrap
├─ turn-manager.ts         # round‑robin scheduler with watchdog + proactive ticks
├─ chat.ts                 # chatOnce (streaming), summarizeOnce, SSE handling, tool harness
├─ agent-model.ts          # AgentModel: tools, context mgmt, inbox, turn integration
├─ python-model.ts         # PythonModel: python_run tool
├─ model.ts                # base Model interfaces and RoomMessage
├─ extract-tool-calls.ts   # parses embedded tool calls from text
├─ channel-lock.ts         # ChannelLock for critical sections
└─ README.md
```

---

## Requirements

Guest (VM):
- Debian/Ubuntu ARM64 (tested on Debian 12)
- **Bun** v1.2+
- `python3`, `git`, `curl`

Host (or another server the VM can reach):
- An **OpenAI‑compatible** server (e.g. **Ollama** or **LM Studio**) listening on a network interface the VM can reach.

Environment examples (VM → Host‑only network):

```bash
# VM expects an OpenAI‑compatible base URL
export OAI_BASE="http://192.168.56.1:11434"     # Ollama or LM Studio server
export OAI_MODEL="openai/gpt-oss-20b"           # default model id
```

> **Note:** If you use LM Studio, it also exposes `/v1/chat/completions`. Unexpected GETs like `/api/version` will log warnings; they are harmless.

---

## Quick Start

```bash
bun install

# Default trio (alice, carol, bob) using the default model
bun run main.ts

# Pick models per‑persona
bun run main.ts -a alice=openai/gpt-oss-120b -a carol=google/gemma-3-27b -a bob

# Or CSV form
bun run main.ts --agents "alice=gpt-oss:20b,carol,bob=lmstudio/my-local"
```

**Keys (interactive mode):**
- `i` — Interject. Pauses streams, aborts current turns, prompts for your message, then resumes.
- `s` — Send a system message.
- `q` or `Ctrl+C` — Quit.

---

## Interactive vs Script Mode

- **Interactive (default)**: enabled automatically when stdout & stdin are TTYs. Shows a periodic banner and handles `i/s/q` keys. Output is colored with timestamps.
- **Script mode**: `--no-interactive`, or when piping input. No key handling or TUI interception; raw streaming is printed as it arrives. You can also pass a kickoff with `--prompt` or via stdin.

Examples:

```bash
# Script mode with explicit prompt
bun run main.ts --no-interactive --prompt "Scan the repo and propose the next task"

# Pipe kickoff
echo "List files and build" | bun run main.ts --no-interactive
```

---

## Personas & Models (CLI)

Flags (repeatable unless noted):

```
-a, --agent, --persona   name[=model]
--agents                 CSV of name[=model]
--default-model          model id used when not specified per agent
--prompt                 kickoff prompt (script mode)
--no-interactive         force script mode
--interactive            force interactive mode
```

If no personas are provided, the default trio is used: **alice, carol, bob** (all with `--default-model` or the compiled default).

---

## Turn Manager

The **Turn Manager** decouples message arrival from execution so agents take turns predictably.

Default options (set in `main.ts`):

```ts
{
  tickMs: 400,          // scheduler cadence (one agent per tick)
  turnTimeoutMs: 8000,  // per‑turn watchdog; aborts stuck streams
  idleBackoffMs: 1200,  // back off after a no‑op turn
  proactiveMs: 2500,    // allow periodic proactive “tick” even with no unread
}
```

How it works:
- Each tick, one agent may run at most one turn.
- Agents run when they have **unread** messages or when a **proactive** tick is due.
- When you interject, the scheduler **pauses**, streams are **aborted**, your messages are broadcast, then the scheduler **resumes**.

---

## Tool Calling

- Declared tool calls in the assistant response and **embedded** tool calls inside text are both executed in‑turn.
- Built‑in tools:
  - **`sh`** — executes shell commands in the VM (stdout/stderr captured, CRLF normalized)
  - **`python_run`** — executes small Python programs with a timeout
- `AgentModel` also offers `chat_mode` (e.g. `group`, `direct:<modelId>`, `file:<path>`), allowing an agent to switch models or read a local file as context.

---

## Streaming & Console Output

- Uses `/v1/chat/completions` with `stream: true`.
- SSE deltas are reassembled to a single message, and **tool calls** are detected from the final JSON and from embedded tags in text.
- Console output:
  - **Timestamps** on each line.
  - **Colors** for readability.
  - **Line ending normalization** so build logs and compiler errors remain readable.
  - A periodic **white‑on‑black banner** (`[q] Quit  [i] Interject  [s] System …`) that scrolls with the content rather than pinning.

---

## Security in the VM

- Run the VM with a **host‑only network** and bind your model server to that interface.
- Optional: restrict egress to only the model host/port.

```bash
sudo ufw --force reset
sudo ufw default deny outgoing
sudo ufw allow out to 192.168.56.1 port 11434 proto tcp
sudo ufw enable
```

---

## Troubleshooting

**No output / stalls**
- Verify the VM can reach the host: `curl -sS http://<HOST-IP>:11434/v1/models`.
- If turns run only once, ensure the **Turn Manager** is enabled (see `main.ts`) and `proactiveMs` is set (prevents “first‑turn only” behavior).
- Very long thoughts with no tokens: reduce `turnTimeoutMs` (defaults to 8s here) and rely on proactive ticks.

**LM Studio warnings**
- Messages like `Unexpected endpoint or method. (GET /api/tags)` are harmless; the app pings some Ollama‑style endpoints.

**Jinja template errors**
- Some community models require alternating roles. In LM Studio you can disable/override the template under *My Models → Prompt Template*.

**Interjects ignored**
- Interject pauses the scheduler, aborts streams, and broadcasts a marked user message plus a resume nudge. If models still ignore it, try reducing `idleBackoffMs` and confirm your model supports tool calling if you expect tools to run.

**Line endings look wrong**
- The stream normalizes `\r\n` → `\n` and lone `\r` → `\n`. If a tool prints without trailing newlines, you’ll see partial lines until the tool finishes.

---

## License

MIT