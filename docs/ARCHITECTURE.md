# Architecture

## How it Works (High Level)

1. **Project root detection** — run inside the current directory, or pass `-C` / `--project <dir>`.
2. **Session & policy** — construct write policy (allow/deny), limits, and pick backend (`podman` or `none`).
3. **Sandbox prep** (podman) — mount `/project:ro`, copy to `/work:rw`, initialize a baseline commit.
4. **Tool loop** — the agent calls tools (primarily `sh`), producing step artifacts `steps/step-N.{out,err,meta.json}`.
5. **Policy enforcement** — we commit each step, compute changed paths, **revert the step commit** if any changed file violates policy, and record `step-N.violation.txt`.
6. **Finalize & review** — build `session.patch` (`baseline..HEAD`), open a pager for review, prompt to apply (or auto-apply if `--review auto` and patch is small, clean, and touches no restricted paths).

## System Overview

* **Scheduler** (`src/scheduler/*`): runs agents in ticks, enforces tool budgets, asks the user when an agent requests input, and prioritizes explicitly tagged replies (`@@agent`) in the very next tick.
* **Router & Inbox**: routes sanitized messages to target agents or `@@group`; the inbox buffers per-agent mail so scheduling is deterministic.
* **Streaming sanitization** (`src/utils/llm-noise-filter.ts`): strips tool-style sentinels from model streams while preserving `fenced code`. No duplication on `flush()`.
* **Safe file writes** (`src/tools/file-writer.ts`): all `##file:` effects are applied **once** inside the sandbox (base64→temp→rename), with path normalization, size limits, and deny-first policy.
* **Sandbox** (`src/sandbox/backends/podman.ts`): `/project:ro`, `/work:rw`, rootless, cap-dropped; each step is committed, violations revert, and a run-scoped patch is emitted.
* **TTY controls** (`src/input/controller.ts`, `src/input/tty-guard.ts`): raw-mode hotkeys for interjection, cooked-mode prompts, and process-level guards to always restore the terminal.

## Streaming Sanitization (Model Output)

* All model tokens pass through `LLMNoiseFilter`, which removes sequences like:

  ```
  <|channel|>commentary to=functions sh<|message|>{"cmd":"…"}
  ```

  while preserving `fenced blocks` verbatim.
* Invariants:

  * For any chunking, `feed().cleaned + flush()` = original **minus** sentinels.
  * The carry buffer holds **only un-emitted** prefixes (e.g., a split token) → no "double text" on flush.

Files: `src/utils/llm-noise-filter.ts`, tests in `src/utils/llm-noise-filter.test.ts`.

## Robust Patch Apply

Patches generated from the sandbox are applied to the host repo with a two-stage strategy:

1. Try index-aware, 3-way:

   ```bash
   git apply --index --3way --whitespace=nowarn session.patch && git commit -m "Apply org session patch"
   ```
2. Fallback to worktree if the index doesn't match (e.g., new paths):

   ```bash
   git apply --reject --whitespace=nowarn session.patch
   # fail if any *.rej exist, else:
   git add -A && git commit -m "Apply org session patch"
   ```

Script: `src/cli/apply-patch.ts`. This avoids "does not exist in index" failures and surfaces true conflicts as `*.rej`.

## Interactive Mode & TTY Safety

* **Hotkeys**: `i` interjects; `Esc` finalizes gracefully; `Ctrl+C` aborts immediately.
* **Guarantees**:

  * Prompts run under `withCookedTTY(...)` and restore the prior raw state on success/failure.
  * `installTtyGuard()` restores the TTY on `exit`, `SIGINT`, `SIGTERM`, `uncaughtException`, and `unhandledRejection`.

Files: `src/input/controller.ts`, `src/input/tty-guard.ts`.

## Artifacts

Files **added** during the run are copied from the sandbox to:

```
.org/runs/<id>/artifacts/<path>
```

This is handy for compiler outputs, generated docs, or any "outside the repo" products you want to keep with the run.