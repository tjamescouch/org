
# Architecture

> **Scope.** This document describes the runtime architecture of **org** — a CLI that lets one or more LLM-backed agents plan and execute reproducible steps *inside a Git repository* under strict guardrails. It reflects the current repository state extracted on 2025-09-09 and corrects paths/behaviors that have drifted from older docs.

---

## 1) High-level flow

```
user (TTY) ──┐
             │ 1. CLI → Runtime init (env, TTY, hotkeys)
             ├─ 2. Project root resolution
             ├─ 3. Config & mode (safe, review mode, PATH)
             ├─ 4. Agents + Scheduler (RR/Random) start
             ├─ 5. Event loop (ticks):
             │     agent ← messages (inbox)
             │       ↳ driver.chat(...) → tool calls?
             │       ↳ StandardToolExecutor.run(...)
             │            ↳ sh tool → sandbox backend (local/mock)
             │            ↳ stdout/stderr captured as step artifacts
             │       ↳ router: @@tags, @@user, ##file:name, etc.
             │           ↳ FileWriter persists files (sanitized)
             │           ↳ ask-user bridge if needed
             └─ 6. Finalize → build session patch → review/apply
```
Key properties:

* **Deterministic, reviewable runs** — each step’s stdout/err and metadata are persisted under `.org/runs/<id>/steps/step-N.*`; a binary-safe Git patch is produced and can be interactively reviewed/applied.
* **Guarded execution** — an execution gate + pluggable guards block dangerous commands and optionally require explicit user approval in *safe* mode.
* **Streaming hygiene** — an output filter removes tool protocol noise while preserving fenced code blocks verbatim for copy/paste and file writes.

---

## 2) Major components (by responsibility)

| Area | Key modules (current paths) | Responsibility |
|---|---|---|
| **Entry & runtime** | `src/app.ts`, `src/runtime/runtime.ts`, `src/runtime/hotkeys.ts`, `src/runtime/process-guards.ts`, `src/runtime/shutdown.ts` | Parse CLI/ENV, detect runtime (Bun/Node), own a single `TtyController`, install hotkeys (ESC / Ctrl+C), and coordinate graceful shutdown (drain, finalize, review/apply). |
| **Project/root** | `src/project/resolve.ts` | Find the repo root (prefer `git -C <seed> rev-parse --show-toplevel` with fallback to walking for `.git/`). |
| **Config & PATH** | `src/config/config.ts`, `src/config/path.ts`, `src/config/paths.ts`, `src/runtime/env-forward.ts` | Load runtime + LLM config, compose a deterministic `PATH`, and forward a curated subset of environment variables to child processes. |
| **Agents** | `src/agents/agent.ts`, `src/agents/llm-agent.ts`, `src/agents/system-prompt.ts` | Define the agent interface and an LLM-driven agent that can emit tool calls, tag participants, and produce final text. |
| **Drivers (LLM)** | `src/drivers/openai-lmstudio.ts`, `src/drivers/streaming-openai-lmstudio.ts`, `src/drivers/types.ts` | OpenAI-compatible chat drivers (incl. streaming) with timeouts and rate-limiting hooks. |
| **Scheduler** | `src/scheduler/*.ts` (`inbox.ts`, `filters.ts`, `router.ts`, `random-scheduler.ts`, `round-robin-scheduler.ts`, `types.ts`) | Tick-based loop that selects agents, enforces tool budgets, routes messages (DM/group/user/file), and coordinates “ask user” prompts. |
| **Routing & tags** | `src/routing/route-with-tags.ts`, `src/utils/tag-parser.ts`, `src/utils/tag-splitter.ts` | Parse `@@mentions`, detect `##file:name` effects, and compute deliveries to agents/user/files. |
| **Tools & execution** | `src/tools/sh.ts`, `src/executors/standard-tool-executor.ts`, `src/executors/tool-executor.ts` | Tool surface (currently POSIX **sh**) and a standard executor that runs requested tools and feeds results back as tool messages. |
| **Execution gate & guards** | `src/tools/execution-gate.ts`, `src/tools/execution-guards.ts` | Global gate (interactive confirmation in safe mode) and pluggable guards (`NoDangerousRm`, `NoRm`, `NoGitAdd/Commit/Push`, …). |
| **Sandbox** | `src/sandbox/*` (`session.ts`, `detect.ts`, `policy.ts`, `types.ts`, `backends/local.ts`, `backends/mock.ts`) | Abstract execution backend. **Local** runs on the host in the project dir; **Mock** records deterministic step files without executing. Types also mention `podman/docker`, but container backends are currently orchestrated via scripts (below). |
| **Run manifest & artifacts** | `src/replay/manifest.ts`, `src/lib/session-patch.ts` | Typed JSON manifest helpers and helpers to locate the last session patch. |
| **File I/O** | `src/io/file-writer.ts`, `src/io/portable-fs.ts` | Safe file writes: sanitize content, ensure trailing newline, create parent dirs, and write atomically. |
| **UI** | `src/ui/console/index.ts`, `src/ui/tmux/*`, `src/ui/prompt-label.ts`, `src/ui/user-prompt.ts` | Console is passive; tmux UI composes `/work/.org/{tmux.conf, tmux-inner.sh}` then launches a private tmux server; pretty prompt labels on TTY. |
| **Sanitization (LLM streams)** | `src/utils/llm-noise-filter.ts`, `src/utils/filter-passes/*` | Stateful PDA-based stream filter removes tool sentinels & analysis/memory blocks, unwraps tool results, and preserves fenced code verbatim. |
| **Memory (conversation)** | `src/memory/*` | Agent and summary memory implementations to bound context and retain dialogue state. |
| **CLI patch apply** | `src/cli/apply-patch.ts`, `scripts/host-patch-review.sh` | Build/apply patches against the host repo with `git apply --index` (3-way fallback in the CLI path) and a TTY review prompt. |
| **Container scripts** | `Containerfile`, `Dockerfile.sandbox`, `scripts/org*`, `scripts/apply_patch`, `scripts/org-patch-create` | When running inside a containerized UI, mount `/project` (RO) and stage a working copy at `/work` (RW). Steps land under `/work/.org/runs/<id>`, and `org-patch-create` emits a binary-safe diff. |

---

## 3) Detailed dataflow

### 3.1 Startup
1. **Runtime init** (`src/runtime/runtime.ts`): detect Bun/Node, wrap process streams, and install hotkeys (`src/runtime/hotkeys.ts`) and debug guards (`src/runtime/process-guards.ts`).
2. **Project root** (`src/project/resolve.ts`): resolve the Git root (via `git` or upward search).
3. **Config & mode** (`src/config/*`): compute PATH; load runtime config (e.g., `safe` mode) and set review mode (`ask` / `auto` / `never`).
4. **Agents & scheduler** (`src/agents/*`, `src/scheduler/*`): build agents from CLI flags; construct a scheduler (round‑robin or random).

### 3.2 Scheduler tick
1. Dequeue messages for an agent (`Inbox.nextPromptFor`).
2. Call `driver.chat(...)`. The agent may return tool calls (e.g., **sh**) and/or final text.
3. Execute tools via `StandardToolExecutor`. For **sh**, spawn a child process in the **sandbox backend**:
   * **Local:** run on the host in the project directory; capture stdout/stderr to files.
   * **Mock:** don’t execute; write deterministic step files (JSON meta, `.out`, `.err`) for tests.
4. Route the agent’s output (`router.ts` + PDA filters):
   * `@@name` → DM another agent (next tick prioritization).
   * `@@user` → yield to the user (scheduler asks via `ui/user-prompt.ts`).
   * `##file:path` → sanitize and write via `FileWriter`.
5. Enforce budgets (max tool calls) and decide the next ready agent.
6. Loop until agents report completion and/or the user exits (ESC).

### 3.3 Finalize, review, apply
* On exit/ESC, the app **finalizes** open sessions. In container/mock modes, a run directory like `.org/runs/<id>` is created with `steps/` and (when available) a `session.patch`.
* In host/console mode, the CLI applies a session patch via `src/cli/apply-patch.ts` (index‑aware, with 3‑way fallback) or prompts with `scripts/host-patch-review.sh`. Conflicts surface via `*.rej` files.

---

## 4) Security & guardrails

* **Execution gate** (`execution-gate.ts`) mediates *all* external execution. In **safe** mode and on an interactive TTY, it asks for confirmation for guarded actions.
* **Guards** (`execution-guards.ts`) block dangerous patterns (`rm -rf /`, general `rm`, and `git add/commit/push` when not explicitly allowed).
* **Sandbox policy** (`sandbox/policy.ts`) defines write allowlists (e.g., `.org/**`, `dist/**`) and basic resource limits. Backends may interpret these limits differently; the **Mock** backend enforces them in manifest only.
* **TTY recovery**: hotkeys & process guards ensure the terminal is restored on exit, Ctrl+C, or exceptions.

---

## 5) Streaming sanitization invariants

The PDA‑based filter (`utils/llm-noise-filter.ts` + passes) guarantees:

* **Idempotent streaming:** For any chunking, `feed().cleaned + flush()` equals the original *minus* tool sentinels and analysis/memory wrappers.
* **Fenced code integrity:** Triple‑backtick blocks are preserved byte‑for‑byte.
* **Tool unwrapping:** `tool_result` payloads are unwrapped; tool_call lines and invalid channels are dropped.
* **Mention normalization:** Leading `@@user` spacing is normalized for routing.

Tests live under `src/utils/__tests__` and validate tricky interleavings.

---

## 6) UI modes

* **Console:** passive; stdin ownership lives in `TtyController` (no double‑echo/focus bugs).
* **tmux:** `/work/.org/tmux.conf` + inner script launch a private server (socket‑scoped), pipe pane output to logs, and keep the pane on screen after exit for postmortem. See `src/ui/tmux/*` and `scripts/org-launch-tmux*`.

---

## 7) Extensibility guide

* **Add a tool:** define a tool schema (modeled after `SH_TOOL_DEF`), implement an executor, and register in `StandardToolExecutor`. Keep outputs small and binary‑safe.
* **Add a backend:** implement `ISandboxSession` in `src/sandbox/backends/<name>.ts` and wire `detect.ts`. Ensure step meta and artifact paths match `replay/manifest.ts` conventions.
* **Add a scheduler policy:** implement the `IScheduler` surface (`scheduler.ts`) or extend `RandomScheduler` (see `RoundRobinScheduler`).
* **Add a driver:** implement `ChatDriver` in `src/drivers/types.ts` and provide a factory (timeouts, streaming hooks, rate limits).

---

## 8) Directory map (selected)

```
src/
  agents/                 # Agent interfaces and LLM agent
  cli/                    # Patch apply CLI, doctor, args
  config/                 # Config + PATH composition
  drivers/                # OpenAI/LMStudio-compatible drivers
  executors/              # Tool executors
  guard/ guardrails/      # Sanitizers and policy decisions
  input/                  # TTY controller, cooked/raw scopes, prompts
  io/                     # FileWriter + portable FS
  project/                # Project root resolver
  replay/                 # Session manifest helpers
  routing/                # Tag parsing and routing
  runtime/                # Runtime wrapper and process lifecycle
  sandbox/                # Backends (local/mock), policy, session manager
  scheduler/              # Inbox, router, RR/Random schedulers
  tools/                  # sh tool, execution gate & guards
  ui/                     # console + tmux front-ends
  utils/                  # Stream filters, prompt helpers, rate limiter
```

---

## 9) Known gaps & clarifications

* **Container backends:** Type signatures include `podman/docker`, and container images/scripts are present, but **no `podman.ts` backend exists**. Today: **Local** (host) and **Mock** (tests) are implemented; containerized flows are orchestrated by shell scripts (see *Container scripts* above).
* **FileWriter path:** Code lives under `src/io/file-writer.ts` (older docs referenced `src/tools/file-writer.ts`). This doc uses the current path.
* **Patch creation:** In container/mock flows, `scripts/org-patch-create` writes `session.patch`. Host/console flows rely on the CLI’s `apply-patch.ts` and/or the review script. Ensure your deployment path picks one cohesive approach.
* **Sandbox policy in Local:** Resource limits are advisory; Local spawns host processes. Use **safe** mode and guards for additional protection.

---

## 10) Glossary

* **Agent:** An autonomous worker that chats and emits tool calls.
* **Tool:** A constrained capability exposed to the agent (e.g., `sh`).
* **Backend:** The environment where tools execute (`local`, `mock`, containerized).
* **Run directory:** `.org/runs/<timestamp>` with `steps/` (per‑step stdout/err/meta) and optionally `session.patch`.
* **Review modes:** `ask` (prompt user), `auto` (auto‑apply small/clean patches), `never` (skip apply; leave patch on disk).

---

## 11) Security posture

org is **safe-by-default** when used with guards and review enabled. It is **not** a hardened sandbox; containerization improves isolation, but treat it as a developer convenience rather than a security boundary. Use `SECURITY.md` for hardening guidance and prefer read-only mounts for `/project` when containerizing.
