# org

*A small CLI that orchestrates a group of LLM “agents” with turn‑based scheduling, a shell execution tool, and clean streaming to the terminal.*

---

## Table of Contents
- [Highlights](#highlights)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Interactive vs Script Mode](#interactive-vs-script-mode)
- [Personas &amp; Models (CLI)](#personas--models-cli)
- [Turn Manager](#turn-manager)
- [Tools &amp; Actions](#tools--actions)
- [Streaming &amp; Console Output](#streaming--console-output)
- [Security in the VM](#security-in-the-vm)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Highlights

- **OpenAI‑compatible chat streaming** via `/v1/chat/completions` with SSE parsing.
- **Turn‑based scheduling** (round‑robin) with a watchdog and lightweight **proactive ticks** to avoid stalls.
- **Shell tool (`sh`)** to run POSIX commands inside the VM (stdout/stderr captured; line endings normalized).
- **Interjections**: `i` to interject, `s` to send a system message, `q`/`Ctrl+C` to quit.
- **Readable output**: timestamps, colours, and a periodic white‑on‑black banner that scrolls with the content.
- **Personas**: choose which agents to start and which model each should use via CLI flags.

> This README only lists features present in the codebase. “Tags” that look like `******* sh ...` in transcripts are parsed as *actions* and may invoke the `sh` tool when recognized; they are not tools by themselves.

---

## Architecture

```
/org
├─ org.ts                  # CLI entry: TUI/script mode, persona parsing
├─ run.sh                  # example launcher (env + one-shot run)
├─ src/
│  ├─ core/
│  │  ├─ chat-room.ts      # room broadcast/send plumbing
│  │  ├─ turn-manager.ts   # round‑robin scheduler + proactive ticks
│  │  ├─ entity/agent-model.ts  # agent runtime, tool wiring, #file handling
│  │  ├─ abort-detectors.ts     # stream guards + sanitizers
│  │  ├─ channel-lock.ts   # ChannelLock for critical sections
│  │  ├─ backpressure.ts   # transport single‑flight gate
│  │  ├─ debug-hooks.ts    # optional instrumentation
│  ├─ transport/chat.ts    # `/v1/chat/completions` (streaming)
│  ├─ ui/                  # logger, key input, TUI bootstrap
│  ├─ constants.ts
│  └─ types.ts
└─ package.json
```

---

## Requirements

Guest (VM):
- Debian/Ubuntu ARM64 (tested on Debian 12)
- **Bun** v1.2+
- `git`, `curl`, `python3` (optional for scripts you may call via `sh`)

Host (or another server the VM can reach):
- An **OpenAI‑compatible** server (e.g. **Ollama** or **LM Studio**) listening on a network interface the VM can reach.

Environment (VM → Host‑only network):

```bash
# Model server base URL and default model
export OAI_BASE="http://192.168.56.1:11434"   # Ollama/LM Studio
export OAI_MODEL="openai/gpt-oss-20b"         # default model id

# Optional: provide the prompt via env if you don't pass --prompt
export PROMPT="Hello from org"
```

> LM Studio exposes `/v1/chat/completions`. If the app probes Ollama‑style endpoints like `/api/tags`, Studio may log warnings; these are harmless.

---

## Quick Start

```bash
bun install

# Default pair (alice, bob) using the default model
bun run org.ts

# One‑shot script mode
bun run org.ts --prompt "Scan the repo and propose the next task"

# Personas with per‑agent model & extra system text
bun run org.ts --prompt "Work together on a plan." \
  --personas "alice#openai/gpt-oss-120b#[You are concise],bob#google/gemma-3-27b"

# Stdin as prompt (use '-' or PROMPT env)
echo "List files and build" | bun run org.ts -
```

---

## Interactive vs Script Mode

- **Interactive (default)**: If stdout &amp; stdin are TTYs and `--prompt` is not provided, the TUI starts. Keys:
  - `i` — Interject. Pauses streams, aborts the current turn, prompts for your message, then resumes.
  - `s` — Send a system message.
  - `q` or `Ctrl+C` — Quit.
- **Script mode**: Supply `--prompt` or pipe stdin. No key handling; raw streaming is printed as it arrives.

---

## Personas &amp; Models (CLI)

Flags (repeatable unless noted):

```
--personas "name#model#[extra],name2#model2"
--default-model MODEL
--prompt TEXT
--interactive | --no-interactive
-s, --safe        # prompt for Enter before each agent runs (script mode)
```

If no personas are provided, the default pair is used: **alice, bob** (all with `--default-model` or `OAI_MODEL`).

---

## Turn Manager

The **Turn Manager** decouples message arrival from execution so agents take turns predictably.

Default options (set in code):

```ts
{
  tickMs: 400,          // scheduler cadence (one agent per tick)
  turnTimeoutMs: 8000,  // per‑turn watchdog; aborts stuck streams
  idleBackoffMs: 1200,  // back off after a no‑op turn
  proactiveMs: 2500,    // periodic proactive “tick” even with no unread
}
```

How it works:
- Each tick, one agent may run at most one turn.
- Agents run when they have **unread** messages or when a **proactive** tick is due.
- Interject pauses the scheduler, aborts streams, broadcasts your message + a concise system nudge, then resumes.

---

## Tools &amp; Actions

### Tools
- **`sh`** — Executes a POSIX command inside the VM.
  - Output is captured (stdout/stderr), and line endings are normalized.

> If additional tools are introduced, declare them in `agent-model.ts` and wire them in `transport/chat.ts`.

### Actions (embedded tags in text)
- The system can parse **embedded action tags** in assistant text (see `extract-tool-calls` logic).  
- These are *not tools*; they are plain text cues. When a recognized action refers to `sh`, the corresponding command is executed via the same `sh` tool.

---

## Streaming &amp; Console Output

- Uses `/v1/chat/completions` with `stream: true`.
- SSE deltas are reassembled into a single message at the end of a turn.
- Tool calls are taken from the final JSON **and** from recognized embedded action tags.
- Console output:
  - **Timestamps** on each line.
  - **Colours** for readability.
  - **Line ending normalization** to keep build logs and errors readable.
  - A periodic **white‑on‑black banner** (`[q] Quit  [i] Interject  [s] System …`) that scrolls with content.

---

## Security in the VM

- Run the VM with a **host‑only network** and bind your model server to that interface.
- Optional egress restriction to only the model host/port:

```bash
sudo ufw --force reset
sudo ufw default deny outgoing
sudo ufw allow out to 192.168.56.1 port 11434 proto tcp
sudo ufw enable
```

---

## Troubleshooting

**No output / stalls**
- Verify the VM can reach the host: `curl -sS http://&lt;HOST-IP&gt;:11434/v1/models`.
- If turns run only once, ensure the **Turn Manager** is enabled and `proactiveMs` is set (prevents “first‑turn only” behavior).
- Very long thoughts with no tokens: reduce `turnTimeoutMs` and rely on proactive ticks.

**LM Studio warnings**
- Messages like `Unexpected endpoint or method. (GET /api/tags)` are harmless when the server is OpenAI‑compatible but not Ollama.

**Prompt template issues**
- Some community models require alternating roles. In LM Studio, disable/override the Jinja template under *My Models → Prompt Template* if needed.

**Interjects ignored**
- Interject pauses the scheduler, aborts streams, and broadcasts a marked user message plus a concise system nudge. If models still ignore it, try reducing `idleBackoffMs` and confirm your chosen model supports the behaviours you expect.

**Line endings look wrong**
- Streams normalize `\r\n` → `\n` and lone `\r` → `\n`. If a tool prints without trailing newlines, partial lines may appear until it finishes.

---

## License

MIT
