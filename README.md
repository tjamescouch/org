
# 🚨 org is intended to be run in a VM that talks to LM Studio/Ollama on the host. If you run this on your host, use **safe mode**. 🚨

# org — Minimal Multi-Agent Orchestrator (LM Studio/Ollama + Tools)

`org` is a small, auditable multi-agent runner that:

* schedules agents **round-robin** with a per-turn tool budget,
* lets agents call **tools** (starting with a safe `sh` and a robust `apply_patch`),
* speaks **OpenAI-compatible** API to local backends (LM Studio / Ollama),
* routes assistant messages with a zero-magic tag grammar,
* keeps the **human in the loop** with a hotkey interjection.

Design goals: **clarity**, **predictability**, and **Unix‑y behavior** (it operates in the directory where you invoke `org`).

---

## Contents

* [Quick start](#quick-start)
* [Installation](#installation)
* [VM & networking setup (host ↔ VM)](#vm--networking-setup-host--vm)
* [Configuration](#configuration)
* [Running](#running)
* [How it works](#how-it-works)
* [Tags & routing](#tags--routing)
* [Tools](#tools)
* [Safety](#safety)
* [Project layout](#project-layout)
* [Troubleshooting](#troubleshooting)
* [FAQ](#faq)
* [License](#license)

---

## Quick start

1. **Start your local LLM API**

   * LM Studio: enable *OpenAI Compatible Server*.
   * Ollama: enable the OpenAI endpoint (varies by build).

2. **Install** (from repo root):

```bash
   ./install.sh
````

This symlinks `/usr/local/bin/org` → `<repo>/org` and installs `apply_patch`.

3. **Use from any directory**:

   ```bash
   cd ~/work/scratch
   org --agents "alice:lmstudio,bob:lmstudio" --max-tools 2 --safe
   ```

* **Hotkeys**: press `i` at any time to interject; `Ctrl+C` to exit.

---

## Installation

`install.sh` performs two actions:

* Copies `apply_patch` to `/usr/local/bin/apply_patch`
* Symlinks `/usr/local/bin/org` → `<repo>/org`

Re-run `./install.sh` after updating the repo.
If you previously copied `org` instead of symlinking, remove it and re-install.

---

## VM & networking setup (host ↔ VM)

The recommended setup is **host‑only networking** for host↔VM traffic. That gives you a stable host IP the VM can reach while not exposing your host’s LLM server to your LAN.

### 1) Create the VM

Use a lightweight Debian/Ubuntu VM. Inside the VM, install prerequisites:

```bash
sudo apt update
sudo apt install -y curl git build-essential python3
# Install Bun (used by org)
curl -fsSL https://bun.sh/install | bash
# make Bun available (adjust shell as needed)
export PATH="$HOME/.bun/bin:$PATH"
```

### 2) Network adapters

Use **two adapters**:

* **Adapter 1 – NAT**: VM gets outbound internet. No configuration.
* **Adapter 2 – Host‑Only**:

  * **VirtualBox**: Host‑only network `vboxnet0` (default 192.168.56.1/24). Enable **DHCP**.
  * **VMware/Parallels**: Use their host‑only network; ensure a 192.168.x.x/24 or 10.x.x.x/24 with DHCP.

Result: the **host** has a predictable IP on the host‑only net (e.g., `192.168.56.1`) and the **VM** gets another IP in that range (e.g., `192.168.56.101`).

**Verify inside the VM:**

```bash
ip addr  # look for the host-only interface (e.g., enp0s8) - address like 192.168.56.101
```

### 3) Start the LLM server on the host

* **LM Studio**

  * Preferences → *OpenAI Compatible Server* → enable.
  * **Bind / Listen**: choose “All interfaces” (or 0.0.0.0).
  * **Port**: use `11434` (or your choice; adjust env below).

* **Ollama**

  ```bash
  OLLAMA_HOST=0.0.0.0:11434 ollama serve
  ```

  This binds Ollama’s OpenAI‑compatible endpoints to all interfaces on the host.

> Security note: with **host‑only** networking, the service is visible only to the VM, not your LAN. If you choose **bridged**, restrict with a firewall.

### 4) Point `org` (in the VM) at the host

In the VM:

```bash
export LLM_BASE_URL="http://192.168.56.1:11434"   # host IP on the host-only network
# optional:
export LLM_MODEL="openai/gpt-oss-120b"
```

**Connectivity check:**

```bash
curl -s "http://192.168.56.1:11434/v1/models" | sed 's/},{/},\n{/g' | head
# Expect a JSON list of models. If connection refused: revisit Step 3 bind/port.
```

### 5) Typical gotchas

* Host service bound to `127.0.0.1` only → bind to `0.0.0.0`.
* Host‑only network off or mis‑IP’d → re‑enable or fix DHCP.
* VM can’t reach `192.168.56.1` → reattach host‑only adapter.

---

## Configuration

### Environment

| Variable       | Default                     | Notes                                     |
| -------------- | --------------------------- | ----------------------------------------- |
| `LLM_DRIVER`   | `lmstudio`                  | Driver key (currently `lmstudio`, `mock`) |
| `LLM_PROTOCOL` | `openai`                    | Wire format                               |
| `LLM_BASE_URL` | `http://192.168.56.1:11434` | Host API (override if not using a VM)     |
| `LLM_MODEL`    | `openai/gpt-oss-120b`       | Model id                                  |
| `SAFE_MODE`    | *(unset → false)*           | `1/true/yes` gates shell & file writes    |
| `DEBUG`        | *(unset)*                   | `1/true` prints debug traces              |

Example:

```bash
export LLM_BASE_URL="http://127.0.0.1:11434"
export LLM_MODEL="openai/gpt-oss-120b"
export SAFE_MODE=true
```

### CLI

| Flag              | Example                              | Meaning                                |
| ----------------- | ------------------------------------ | -------------------------------------- |
| `--agents`        | `--agents "alice:lmstudio,bob:mock"` | `name:kind` comma‑separated            |
| `--max-tools`     | `--max-tools 2`                      | Tool budget per agent per turn         |
| `--driver`        | `--driver lmstudio`                  | Driver override                        |
| `--protocol`      | `--protocol openai`                  | Protocol override                      |
| `--base-url`      | `--base-url http://127.0.0.1:11434`  | Base URL override                      |
| `--model`         | `--model openai/gpt-oss-120b`        | Model override                         |
| `--recipe`        | `--recipe fix`                       | Optional recipe (e.g., `fix`, `build`) |
| `--interject-key` | `--interject-key i`                  | Hotkey for user interjection           |
| `--banner`        | `--banner "You: "`                   | Prompt shown when asking the user      |
| `--safe`          | `--safe`                             | Enable confirmations                   |
| `--debug`         | `--debug`                            | Enable debug logging                   |

---

## Running

With **Bun** (recommended):

```bash
org --agents "alice:lmstudio,bob:lmstudio" --max-tools 2 --safe
```

Behavior is **Unix‑y**: all shell commands and file writes happen in the directory where you invoked `org`. The launcher (`org` + `runner.ts`) ensures the process `cwd` matches your invocation directory.

Loop semantics:

1. Broadcast user input to all agents (others appear as `role:"user"` to each).
2. Round‑robin through agents; each gets up to `--max-tools` tool calls.
3. If an agent returns plain text (no tools), it yields.
4. Exit after two idle passes (nothing to do). `Ctrl+C` at any time to quit.

**Hotkey**: press `i` to interject a user message immediately.

When the agents are started you should see them use tools from within the orchestrator UI (streaming tokens, streamed tool‑call deltas, and structured tool outputs).

---

## How it works

* **Drivers** (`src/drivers/*`): OpenAI‑compatible clients for LM Studio/Ollama. Includes a **streaming** driver that renders reasoning/content tokens and streams tool‑call deltas.
* **Agents** (`src/agents/*`): `LlmAgent` wraps a driver, executes tools, and maintains state via memory. `MockModel` exists for smoke tests.
* **Memory** (`src/memory/*`): a *scrubbed advanced memory* that keeps separate lanes (assistant/system/user), summarizes overflow to fit a target token budget, and preserves recent tool outputs.
* **Guardrails** (`src/guardrails/*` + `src/guard/sanitizer.ts`): detects stagnation and no‑progress tool loops, nudges/fences repeated failures, and sanitizes/repairs assistant tool calls (e.g., converting inline `cmd: "..."` to a proper `sh` call).
* **Router** (`src/routing/route-with-tags.ts`): resolves `@@agent`, `@@group`, `@@user`, and `##file:...` sections and dispatches them.
* **Scheduler** (`src/scheduler.ts`): round‑robin with per‑agent inboxes, user hand‑off, and end‑of‑turn mute windows from guardrails.
* **Input controller** (`src/input/*`): single‑owner stdin state machine; hotkey interject; line‑mode prompts; TTY hand‑off for tools if needed.

---

## Tags & routing

Use inline tags inside assistant messages:

* `@@bob …` — direct message to agent `bob`
* `@@group …` — broadcast to all agents
* `@@user …` — yield to user
* `##path/to/file.ext …lines…` — file “attachment” (persisted via file handler)

The router splits these parts and delivers them to agent inboxes or the file handler.

---

## Tools

### `sh` (shell)

Function‑calling tool that runs a POSIX command and returns JSON `{ ok, stdout, stderr, exit_code, cmd }`.
By default runs in the **invocation directory**.

**Schema (OpenAI tools):**

```json
{
  "type": "function",
  "function": {
    "name": "sh",
    "description": "Run a POSIX shell command in the current working directory. Returns JSON: { ok, stdout, stderr, exit_code, cmd }.",
    "parameters": {
      "type": "object",
      "properties": {
        "cmd": { "type": "string", "description": "Command to run" }
      },
      "required": ["cmd"]
    }
  }
}
```

### `apply_patch`

A tolerant patch applier for AI‑generated diffs. Supports:

* `*** Begin/End Patch` blocks
* `*** Update/Add/Delete/Rename File:` headers
* Unified `@@` hunks with `-`/`+`/context lines
* **Anchor directives** inside `@@`:

  * `@@ at:top @@`, `@@ at:bottom @@`
  * `@@ before:/regex/ @@`, `@@ after:/regex/ @@`
* Idempotence (no‑op if change already applied)
* Whitespace‑insensitive hunk matching

Examples:

```
*** Begin Patch
*** Update File: src/main.ts
@@
-console.log("hello");
+console.log("hello world");
*** End Patch
```

```
*** Begin Patch
*** Update File: src/main.ts
@@ at:top @@
+console.log("[diag] cwd=", process.cwd());
*** End Patch
```

```
*** Begin Patch
*** Update File: README.md
@@ after:/^## Quick start/ @@
+> Tip: press `i` to interject at any time.
*** End Patch
```

---

## Safety

`ExecutionGate` enforces an approval step and optional guards:

* `--safe` or `SAFE_MODE=true` prompts before running `sh` or writing files.
* Policy guards deny suspicious commands (e.g., `rm -rf /`, `git push`, etc.).
* All file writes happen in the caller’s directory; backups are taken by `apply_patch`.

---

## Project layout

```
org                      # wrapper script (installed via symlink)
runner.ts                # ensures process.cwd() = caller's directory
install.sh               # installs org + apply_patch
apply_patch              # robust patch applier

src/
  app.ts                 # CLI/entrypoint, scheduler wiring, recipes, streaming UI
  logger.ts              # color/stream logging
  recipes.ts             # optional presets (e.g., fix/build/chat) + budgets
  scheduler.ts           # round-robin loop, routing, user prompts
  types.ts               # basic chat types used by older modules

  config/
    config.ts            # env/CLI parsing and LLM/runtime config
    path.ts, paths.ts    # path helpers

  input/
    controller.ts        # single-owner stdin (hotkeys + prompts)
    tty-handoff.ts       # TTY handoff for interactive tools
    utils.ts, types.ts

  drivers/
    types.ts
    openai-lmstudio.ts               # non-streaming OpenAI-compatible client
    streaming-openai-lmstudio.ts     # streaming client (tokens + tool deltas)

  agents/
    agent.ts              # base agent + guard integration
    llm-agent.ts          # LLM agent with memory/tool loop
    mock-model.ts         # test stub
    system-prompt.ts      # default/system prompt text

  executors/
    tool-executor.ts
    standard-tool-executor.ts        # executes sh (and extensible)

  guardrails/
    guardrail.ts
    advanced-guardrail.ts            # loop detection, nudges, end-turn decisions

  guard/
    sanitizer.ts          # repair/sanitize assistant tool-use

  memory/
    agent-memory.ts
    summary-memory.ts
    advanced-memory.ts
    scrubbed-advanced-memory.ts
    context-limited-summary-memory.ts
    index.ts

  routing/
    route-with-tags.ts

  io/
    file-writer.ts
    portable-fs.ts

  tools/
    sh.ts
    execution-gate.ts
    execution-guards.ts
    vimdiff.ts             # implemented; disabled by default in tool list

  utils/
    extract-code-blocks.ts
    rate-limiter.ts
    restore-stdin.ts
    sanitize-content.ts
    shuffle-array.ts
    sleep.ts
    spawn-clean.ts
    tag-parser.ts
    timed-fetch.ts

test/
  app.test.ts             # Tag parsing, router, sh tool, agent tool-loop tests
```

---

## Troubleshooting

**Interjection echoes or is lost**
You’re using the input controller now (single stdin owner). Prompts and hotkeys are serialized; interjections are routed through the same path as normal user messages.

**Everything runs in the repo instead of my working dir**
Install via `./install.sh` (symlink), and ensure `/usr/local/bin/org` points to the repo script. The launcher + runner set `cwd` to the invocation directory.

**`apply_patch` keeps saying “hunk not found”**
Use anchor directives (`at:top`, `after:/regex/`, etc.), or provide a bit more context; if the `+` block already exists it succeeds with no changes.

**LLM server connection refused**

* Confirm host‑only IP (often `192.168.56.1`) and port match your server.
* Ensure LM Studio/Ollama is bound to `0.0.0.0` or the host‑only interface.
* From the VM, `curl http://192.168.56.1:11434/v1/models` should return JSON.

**Safe mode blocks everything**
You enabled `--safe` or `SAFE_MODE=true`. Confirm prompts with `y`, or disable for a trusted workspace.

---

## FAQ

**Why do other agents appear as `role:"user"`?**
It matches the OpenAI function‑calling pattern and keeps tool loops simple.

**Where are files written?**
In the directory where you ran `org` (not the repo). This is enforced by the wrapper + runner.

**Can I add more tools or drivers?**
Yes—tools are plain modules returning JSON; drivers implement a small `ChatDriver` interface.

---

## License

MIT. Contributions welcome.
