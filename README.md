
# org

_Agentic dev helper that can “do things” in your repo while you watch, review,
and approve every change._

- ✍️ **Conversational**: give a task, the agent plans and executes.
- 🤝 Collaborative: works as part of a multi-agent setup, coordinating steps and maintaining a conversation between the agents.
- 🧰 **Tools**: `sh`, `apply_patch`, etc. 100% auditable.
- 🔒 **Safe-by-default**: denylist for dangerous paths; *every* change turns into
  a patch you review before it lands.
- 🧪 **Deterministic runs**: all stdout/stderr, artifacts, and a git patch are
  saved under `.org/runs/<id>` for inspection or CI upload.
- 🛡️ **Optional containerized sandbox**: run steps inside a Podman container
  with no network by default. :contentReference

> This is a developer productivity tool, not a security boundary. See
> [SECURITY.md](SECURITY.md) for hardening guidance.

---

## Contents

- [Quick start](#quick-start)
- [Installation](#installation)
- [CLI](#cli)
- [Configuration](#configuration)
- [Sandbox (optional)](#sandbox-optional)
- [Write policy](#write-policy-what-files-the-agent-may-touch)
- [Streaming output & heartbeat](#streaming-output--heartbeat)
- [Patches, commits, and diffs](#patches-commits-and-diffs)
- [Artifacts](#artifacts)
- [How it works (high level)](#how-it-works-high-level)
- [Running from any directory](#running-from-any-directory)
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)
- [License](#license)

---

## Quick start

```bash
# 1) From a working repo with a clean git tree:
git status

# 2) Start an agent (uses your local LLM by default)
org --agents "alice:lmstudio" --max-tools 20

# 3) Ask for something small
@alice write “hello world” to a file named hello/hello-world.txt
````

When the tool wants to touch the filesystem, it first produces a **patch**. You
can read, approve, or reject it. After approval, the agent continues.&#x20;

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

`session.patch` is produced from a baseline commit created at run start, so it
contains exactly what changed during this run.&#x20;

---

## Installation

This project uses **Bun**.

```bash
bun install
bun run build    # if you have a build step
```

Optionally ensure Podman is installed if you plan to use the sandbox backend.

---

## CLI

```bash
org [options] [--prompt "…"]
```

Common options:

| Flag / Env                     | Meaning                                                   |                            |                                                   |
| ------------------------------ | --------------------------------------------------------- | -------------------------- | ------------------------------------------------- |
| `--agents "alice:lmstudio,…"`  | Configure agent(s) and driver(s)                          |                            |                                                   |
| `--max-tools N`                | Cap total tool invocations per run                        |                            |                                                   |
| `--safe` / `SAFE_MODE=1`       | Extra confirmation gates for shell & writes               |                            |                                                   |
| `--review ask                  | auto                                                      | never`                     | Patch review mode (interactive by default on TTY) |
| `-C <dir>` / `--project <dir>` | Run **from any directory**; treat `<dir>` as project root |                            |                                                   |
| `--debug` / `DEBUG=1`          | Verbose logging                                           |                            |                                                   |
| `SANDBOX\_BACKEND=podman       | none\`                                                    | Choose backend (see below) |                                                   |

Examples:

```bash
# Run from anywhere, operate on ~/dev/myrepo
org -C ~/dev/myrepo --agents "alice:lmstudio" --max-tools 50 --review ask

# Auto-apply small/safe patches (applies only if the patch is clean & touches no restricted paths)
ORG_REVIEW=auto org --agents "alice:lmstudio"
```

---

## Configuration

### LLM

Set these to point the app at your local or remote model server:

| Variable       | Default                     | Notes                                 |
| -------------- | --------------------------- | ------------------------------------- |
| `LLM_DRIVER`   | `lmstudio`                  | Driver key (e.g., `lmstudio`, `mock`) |
| `LLM_PROTOCOL` | `openai`                    | Wire format                           |
| `LLM_BASE_URL` | `http://192.168.56.1:11434` | Host API (override if not using a VM) |
| `LLM_MODEL`    | `openai/gpt-oss-20b`        | Model id                              |

### Environment

| Variable          | Default     | Notes                                                 |
| ----------------- | ----------- | ----------------------------------------------------- |
| `SAFE_MODE`       | *(unset)*   | `1/true/yes` gates shell & file writes                |
| `DEBUG`           | *(unset)*   | `1/true` prints debug traces                          |
| `SANDBOX_BACKEND` | `auto`      | `podman` or `none` (auto tries `podman`, else `none`) |
| `ORG_REVIEW`      | *(tty→ask)* | `ask`, `auto`, or `never`                             |
| `ORG_PROJECT_DIR` | *(unset)*   | Alternate to `-C/--project`                           |

---

## Sandbox (optional)

### Why run in a sandbox?
| Concern / Feature                        | Host (no sandbox) | Rootless container (our sandbox) | VM (recommended hard boundary) |
| ---------------------------------------- | ----------------: | :------------------------------: | :----------------------------: |
| Perf / startup                           |         ✅ fastest |              ✅ fast              |            ❌ slowest           |
| Reproducibility (pinned toolchain image) |                 ❌ |       ✅ (image pin/digest)       |      ✅ (snapshot + image)      |
| Read-only project view                   |                 ❌ |         ✅ (`/project:ro`)        |      ✅ (mounts you choose)     |
| Controlled write surface (allow/deny)    |         ⚠️ ad-hoc |     ✅ (policy check + revert)    |  ✅ (plus filesystem isolation) |
| No network by default                    |                 ❌ |       ✅ (`--network=none`)       |   ✅ (host-only/ NAT control)   |
| Cap drops / seccomp / userns remap       |                 ❌ |   ✅ (`--cap-drop=ALL`, keep-id)  |    ✅ via hypervisor boundary   |
| Kernel isolation                         |                 ❌ |      ❌ (shared host kernel)      |       ✅ (separate kernel)      |
| Blast radius for a bad command           |       ❌ host-wide |    ⚠️ bounded to mounted dirs    |     ✅ contained to VM disk     |


You can run tools in a disposable **rootless Podman** container. This improves
repeatability and reduces accidental host modifications, while keeping everything
auditable.&#x20;

Enable:

```bash
export SANDBOX_BACKEND=podman
```

**Runtime layout (inside the container)**

```
/project  -> your repo (read-only)
/work     -> a scratch working copy (read-write)
```

We initialize a baseline commit inside `/work`, and compute the patch against
that baseline. Then we copy the patch and any **newly added** files back to
`<repo>/.org/runs/<id>/`.&#x20;

**Base image**

By default we look for `localhost/org-build:debian-12`. You can tag or load an
image that contains `bash`, `git`, `rsync`, and a few coreutils:

```bash
podman pull docker.io/library/debian:12
podman tag  docker.io/library/debian:12  localhost/org-build:debian-12
```

> The repo is bind-mounted; you do not need build toolchains baked into the image
> for most tasks.

---

## Write policy (what files the agent may touch)

Effective defaults:

```ts
allow: ['*', '**/*'],                 // top-level + nested files/dirs
deny:  ['.git/**', '.org/**', '.env', '**/*.pem', '.github/**']
```

Key semantics:

* `*` matches **top-level** names; `**/*` matches **nested** paths but **not**
  top-level. That’s why both appear in `allow`.
* Deny patterns **override** allows.
* The sandbox stages changes while **excluding** `.org/` and `.git/` so the
  patch only contains project edits.

You can override policy when creating a session if needed, but the defaults are
safe for most workflows.

---

## Streaming output & heartbeat

The `sh` tool streams `stdout`/`stderr` **live** to your terminal. During idle
periods, a small **heartbeat** prints a single `.` to `stderr` about once per
second so you know a long-running step is alive. These dots are **suppressed**
whenever an interactive UI is visible (the patch preview pager or the “Apply
this patch?” prompt), to keep the review screen clean.&#x20;

---

## Patches, commits, and diffs

* Each run starts by creating a **baseline commit** in the sandbox working copy.

* After tools complete, we stage changes (skip `.org/`, `.git/`; force-add
  ignored-but-allowed files) and generate a patch:

  ```bash
  git -C /work -c diff.noprefix=false diff --binary <baseline>..HEAD > /work/.org/session.patch
  ```

* On approval, the patch is applied to your repo.

This approach ensures root-level files (e.g. `README.md`) and nested files
produce consistent diffs, and makes it obvious what changed in each run.


---

## Artifacts

Files **added** during the run are copied from the sandbox to:

```
.org/runs/<id>/artifacts/<path>
```

This is handy for compiler outputs, generated docs, or any “outside the repo”
products you want to keep with the run.&#x20;

---

## How it works (high level)

1. **Project root detection** — run inside the current directory, or pass `-C` /
   `--project <dir>`.
2. **Session & policy** — construct write policy (allow/deny), limits, and pick
   backend (`podman` or `none`).
3. **Sandbox prep** (podman) — mount `/project:ro`, copy to `/work:rw`,
   initialize a baseline commit.
4. **Tool loop** — the agent calls tools (primarily `sh`), producing step
   artifacts `steps/step-N.{out,err,meta.json}`.
5. **Policy enforcement** — we commit each step, compute changed paths, **revert
   the step commit** if any changed file violates policy, and record
   `step-N.violation.txt`.
6. **Finalize & review** — build `session.patch` (`baseline..HEAD`), open a
   pager for review, prompt to apply (or auto-apply if `--review auto` and
   patch is small, clean, and touches no restricted paths).

---

## Running from any directory

You don’t have to `cd` into the repo to use `org`. Two equivalent ways:

```bash
org -C /path/to/repo --agents "alice:lmstudio" --max-tools 50
# or
ORG_PROJECT_DIR=/path/to/repo org --agents "alice:lmstudio"
```

When running **inside** a repo, just call `org` normally.

---

## Troubleshooting

* **“No patch produced”**

  * The command didn’t change tracked files (e.g., listing or printing only).
  * The write policy denied the path → see `.org/runs/<id>/steps/step-N.violation.txt`.
  * The change was staged under `.org/` or `.git/` (ignored from patches).

* **Root-level files don’t show up**

  * Ensure policy includes both `'*'` (top-level) **and** `'**/*'` (nested).
  * If the file is ignored by `.gitignore`, we still force-add it when allowed.

* **Patch viewer “what do I press?”**

  * It’s a pager (`delta` or `less`). **q** to quit, then you’ll see:
    `Apply this patch? [y/N]`. Press **y** (Enter) to apply.

* **“Trying to pull localhost/org-build\:debian-12”**

  * Build or tag the base image locally:
    `podman tag debian:12 localhost/org-build:debian-12`.

* **Heartbeat dots over the patch screen**

  * By design they’re suppressed during review; if you still see them, make sure
    you’re on the current build with heartbeat suppression enabled.

---

## Tests

We include tests that exercise:

* **Glob & policy** — `matchAny` semantics; deny-over-allow; top-level vs nested.
* **Patch generation** — root & nested files produce headers with `a/` & `b/`
  prefixes (`-c diff.noprefix=false`).
* **Streaming/heartbeat** — baseline behavior + suppression while UI is up.

Run:

```bash
bun test
```

---

## License

MIT

