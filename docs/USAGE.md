# Usage Guide

## CLI Reference

```bash
org [options] [--prompt "…"]
```

### Common Options

| Flag / Env                     | Meaning                                                   |                            |                                                   |
| ------------------------------ | --------------------------------------------------------- | -------------------------- | ------------------------------------------------- |
| `--agents "alice:lmstudio,…"`  | Configure agent(s) and driver(s)                          |                            |                                                   |
| `--max-tools N`                | Cap total tool invocations per run                        |                            |                                                   |
| `--safe` / `SAFE_MODE=1`       | Extra confirmation gates for shell & writes               |                            |                                                   |
| `--review ask`                 | `auto` / `never`                     | Patch review mode (interactive by default on TTY) |
| `-C <dir>` / `--project <dir>` | Run **from any directory**; treat `<dir>` as project root |                            |                                                   |
| `--debug` / `DEBUG=1`          | Verbose logging                                           |                            |                                                   |
| `SANDBOX_BACKEND=podman`       | `none`                                                    | Choose backend (see below) |                                                   |

## Examples

### Basic Usage

```bash
# Run from anywhere, operate on ~/dev/myrepo
org -C ~/dev/myrepo --agents "alice:lmstudio" --max-tools 50 --review ask

# Auto-apply small/safe patches (applies only if the patch is clean & touches no restricted paths)
ORG_REVIEW=auto org --agents "alice:lmstudio"
```

### Running from Any Directory

You don't have to `cd` into the repo to use `org`. Two equivalent ways:

```bash
org -C /path/to/repo --agents "alice:lmstudio" --max-tools 50
# or
ORG_PROJECT_DIR=/path/to/repo org --agents "alice:lmstudio"
```

When running **inside** a repo, just call `org` normally.

## Day-to-Day Usage

* Run `org` **inside the repo you want to work on**; the tool assumes your *current directory* is the project root.
* Start a session with an initial instruction:

  ```bash
  org --prompt "fix tests"
  ```
* Force a particular UI:

  * Console (default): `org --ui console`
  * tmux: `org --ui tmux`
* Handy envs:

  * `ORG_DEBUG=1` or `LOG_LEVEL=debug` for extra logs
  * `ORG_FORCE_UI=console|tmux` to set a default
  * `ORG_ENGINE=podman` and `ORG_IMAGE=localhost/org-build:debian-12` to override engine/image

## Interactive Controls

### Keyboard Shortcuts

* **`i`** — Interject. Opens a one-line prompt (`You:`) with line editing; after submit, the run resumes.
* **`Esc`** — **Graceful shutdown.** Finalizes the sandbox (if active), saves `session.patch` and artifacts, then exits.
* **`Ctrl+C`** — Immediate abort (best-effort cleanup only). Prefer **Esc** when you want patches/artifacts preserved.

### Quick Verification

From **any** directory:

```bash
org --prompt "say hi"
```

You should see a short interactive run. Logs live under the current project's `.org/logs/` directory. For example:

```bash
tail -f ./.org/logs/last.log
```

To try the tmux integration (runs the console UI *inside* a tmux pane in the container):

```bash
org --ui tmux --prompt "hi there"
```

## Output and Artifacts

All artifacts for each run land in:

```
<your-repo>/.org/runs/<uuid>/
  ├─ manifest.json
  ├─ session.patch
  ├─ steps/
  │   ├─ step-0.out / step-0.err / step-0.meta.json
  │   ├─ step-1.out / …
  │   └─ …
  └─ artifacts/        # files added by the run (copied out of the sandbox)
```

`session.patch` is produced from a baseline commit created at run start, so it contains exactly what changed during this run.

### Streaming Output & Heartbeat

The `sh` tool streams `stdout`/`stderr` **live** to your terminal. During idle periods, a small **heartbeat** prints a single `.` to `stderr` about once per second so you know a long-running step is alive. These dots are **suppressed** whenever an interactive UI is visible (the patch preview pager or the "Apply this patch?" prompt), to keep the review screen clean.

## Multi-Agent Workflows

Run several named agents (e.g., `"alice:lmstudio,bob:lmstudio"`). Agents can hand off tasks and you can interject at any time with **`i`** to steer the plan, while the same review-before-apply loop protects your repo.

### Interaction Protocol & Routing Rules

**Tags**

* `@@<agent>` — DM to a specific agent (explicit tag **wins** and runs **next**).
* `@@user` — ask the human.
* `@@group` — broadcast to all agents.
* `##file:relative/path.ext` followed by the file contents on subsequent lines.

**Defaults**

* If an agent asked for input, an **untagged** reply is DM'd to **that agent**.
* Otherwise, untagged user input goes to `@@group`.

**File rules**

* Only the explicit form `##file:PATH` is accepted (no shorthand).
* Multiple `##file:` blocks for the **same** path in one message → **last-write-wins**.
* File effects are applied **once** (scheduler pre-process) and removed from the routed text.

**Examples**

```text
@@alice please scaffold a test

##file:src/utils/slug.test.ts
import { expect, it } from "bun:test";
import { slug } from "./slug";
it("slug", () => expect(slug("A B")).toBe("a-b"));
```

## Patches and Review

### How it Works

* Each run starts by creating a **baseline commit** in the sandbox working copy.

* After tools complete, we stage changes (skip `.org/`, `.git/`; force-add ignored-but-allowed files) and generate a patch:

  ```bash
  git -C /work -c diff.noprefix=false diff --binary <baseline>..HEAD > /work/.org/session.patch
  ```

* On approval, the patch is applied to your repo.

This approach ensures root-level files (e.g. `README.md`) and nested files produce consistent diffs, and makes it obvious what changed in each run.

### Patch Headers & Root-Level Files

`org` generates diffs with Git's default *prefixed* headers so top-level files (e.g., `README.md`) are handled the same as nested paths. If you're debugging outside the sandbox, mirror the exact flags we use:

```bash
git -c diff.noprefix=false diff --binary <BASE>..HEAD
```

This yields headers like:

```
diff --git a/README.md b/README.md
```

and ensures the patch viewer behaves the same for root and nested edits.

### Pager & Heartbeat

* The patch viewer is a pager (`delta` if present, otherwise `less`). Press **`q`** to exit, then approve or reject.
* The **heartbeat dot** (period printed to `stderr` while a long command runs) is automatically **suppressed** whenever the patch UI or confirmation prompt is visible, so your review screen stays clean.

## Quick Run Inspection

Handy `jq` one-liners:

```bash
# Last run directory
RUN="$(ls -d .org/runs/* 2>/dev/null | sort | tail -1)"

# See the effective write policy that was used
jq -s '.[-1].spec.write' .org/runs/*/manifest.json

# Or just the last run's policy:
jq '.spec.write' "$RUN/manifest.json"

# Show any policy violations (one file per step if blocked)
ls "$RUN"/steps/*violation.txt 2>/dev/null || echo "no violations"

# Pretty-view the patch (falls back to less if delta isn't available)
(delta "$RUN/session.patch" 2>/dev/null) || less -R "$RUN/session.patch"

# What changed between baseline and final?
jq -r '.steps[-1].exitCode as $ec | "last step exit=\($ec)"' "$RUN/manifest.json"
```