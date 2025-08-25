# org

_Agentic dev helper that can “do things” in your repo while you watch, review,
and approve every change._

- ✍️ **Conversational**: give a task, the agent plans and executes.
- 🧰 **Tools**: `sh`, `apply_patch`, etc. 100% auditable.
- 🔒 **Safe-by-default**: denylist for dangerous paths; *every* change turns into
  a patch you review before it lands.
- 🧪 **Deterministic runs**: all stdout/stderr, artifacts, and a git patch are
  saved under `.org/runs/<id>` for inspection or CI upload.
- 🛡️ **Optional containerized sandbox**: run steps inside a Podman container
  with no network by default.

> This is a developer productivity tool, not a security boundary. See
> [SECURITY.md](SECURITY.md) for hardening guidance.

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
can read, approve, or reject it. After approval, the agent continues.

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

> `session.patch` is produced from a baseline commit created at run start, so it
> contains exactly what changed during this run.

---

## Tools

### `sh`

Run a POSIX shell command (inside the sandbox when enabled).

* **Streaming output**: `stdout` and `stderr` stream live to your terminal.
* **Heartbeat**: while a command is idle, a `.` is printed to `stderr`
  approximately once per second so you know it’s alive.
  The heartbeat is **suppressed automatically** when an interactive UI is
  visible (patch-review prompt or confirmation banner) to avoid noisy dots.
* Everything still goes into `steps/step-*.{out,err,meta.json}` for replay.

Example:

```jsonc
{
  "name": "sh",
  "arguments": { "cmd": "bash -lc 'make -j && ctest --output-on-failure'" }
}
```

### `apply_patch`

Apply a unified diff (what the agent proposes). You get to approve first.

---

## Sandboxed runs (optional)

You can run tools in a disposable Podman container. This improves **repeatability**
and reduces accidental host modifications, while still keeping everything
auditable.

### Choosing a backend

Set one of:

```bash
# default is auto (try podman, fall back to none)
export SANDBOX_BACKEND=auto   # or
export SANDBOX_BACKEND=podman # or
export SANDBOX_BACKEND=none
```

* **podman** – Runs steps inside a container. Host paths are mounted read-only
  except a small working directory under `/work`. Network is **disabled** by
  default.
* **none** – Runs directly on the host.

> The code chooses `auto` by default. If Podman is available it is used; if not
> we fall back to `none`.

### Base image

The sandbox expects an image named `localhost/org-build:debian-12`.

You can build or load it in a few ways:

```bash
# 1) Pull or build (example)
podman pull docker.io/library/debian:12
podman tag  docker.io/library/debian:12  localhost/org-build:debian-12

# 2) If you were given an image tarball:
podman load -i org-build-debian12.tar
```

> The image only needs common build tools (bash, git, rsync); the repo itself
> is bind-mounted into the container.

### Where things live

Inside the container:

```
/project  -> your repo (read-only)
/work     -> a scratch working copy (read-write)
```

We initialize a baseline commit inside `/work`, and compute the patch against
that baseline. Then we copy the patch and any **newly added** files back to
`<repo>/.org/runs/<id>/`.

---

## Write policy (what files the agent may touch)

The agent is conservative by default:

```ts
// Effective defaults
allow: ['*', '**/*'],                 // top-level + nested files/dirs
deny:  ['.git/**', '.org/**', '.env', '**/*.pem', '.github/**']
```

A few important rules:

* `*` matches **top-level** names; `**/*` matches **nested** paths but **not**
  top-level. That’s why both appear in `allow`.
* Dotfiles (`.env`, `.gitignore`, etc.) are not matched by `*` or `**/*`. You
  must allow them explicitly.
* Deny patterns **override** allows.

You can override the policy in code when you create a session, but we recommend
sticking with the defaults unless you have a good reason.

---

## Patches, commits, and diffs

* Each run starts by creating a **baseline commit** in the sandbox working copy.
* After tools complete, we stage changes (excluding `.org/` and `.git/`) and
  generate a patch:
  `git -C /work diff --binary --no-prefix <baseline>..HEAD`
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
products you want to keep with the run.

---

## Troubleshooting

* **“No patch produced”**
  Usually means nothing was staged after the step:

  * the write policy denied the path,
  * you only edited files under `.org/` or `.git/`,
  * or the tool created no diff (e.g. identical content).

* **Root-level files don’t show up**
  Make sure your policy includes both `'*'` and `'**/*'` in `allow`, and that the
  deny list does not match the path.

* **Heartbeat dots are noisy**
  They are suppressed automatically during interactive prompts. If you still
  see them, you can temporarily redirect `stderr` from the agent process.

---

## License

MIT

