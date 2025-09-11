# Configuration

## LLM Settings

Set these to point the app at your local or remote model server:

| Variable       | Default                     | Notes                                 |
| -------------- | --------------------------- | ------------------------------------- |
| `LLM_DRIVER`   | `lmstudio`                  | Driver key (e.g., `lmstudio`, `mock`) |
| `LLM_PROTOCOL` | `openai`                    | Wire format                           |
| `LLM_BASE_URL` | `http://192.168.56.1:11434` | Host API (override if not using a VM) |
| `LLM_MODEL`    | `openai/gpt-oss-120b`       | Model id                              |

## Environment Variables

| Variable          | Default     | Notes                                                 |
| ----------------- | ----------- | ----------------------------------------------------- |
| `SAFE_MODE`       | *(unset)*   | `1/true/yes` gates shell & file writes                |
| `DEBUG`           | *(unset)*   | `1/true` prints debug traces                          |
| `SANDBOX_BACKEND` | `auto`      | `podman` or `none` (auto tries `podman`, else `none`) |
| `ORG_REVIEW`      | *(tty→ask)* | `ask`, `auto`, or `never`                             |
| `ORG_PROJECT_DIR` | *(unset)*   | Alternate to `-C/--project`                           |

## Sandbox Configuration

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

You can run tools in a disposable **rootless Podman** container. This improves repeatability and reduces accidental host modifications, while keeping everything auditable.

Enable:

```bash
export SANDBOX_BACKEND=podman
```

**Runtime layout (inside the container)**

```
/project  -> your repo (read-only)
/work     -> a scratch working copy (read-write)
```

We initialize a baseline commit inside `/work`, and compute the patch against that baseline. Then we copy the patch and any **newly added** files back to `<repo>/.org/runs/<id>/`.

**Base image**

By default we look for `localhost/org-sandbox:latest`. You can tag or load an image that contains `bash`, `git`, `rsync`, and a few coreutils:

```bash
podman pull docker.io/library/debian:12
podman tag  docker.io/library/debian:12  localhost/org-sandbox:latest
```

> The repo is bind-mounted; you do not need build toolchains baked into the image for most tasks.

## Write Policy

Configure what files the agent may touch:

### Default Policy

```ts
allow: ['*', '**/*'],                 // top-level + nested files/dirs
deny:  ['.git/**', '.org/**', '.env', '**/*.pem', '.github/**']
```

### Key Semantics

* `*` matches **top-level** names; `**/*` matches **nested** paths but **not** top-level. That's why both appear in `allow`.
* Deny patterns **override** allows.
* The sandbox stages changes while **excluding** `.org/` and `.git/` so the patch only contains project edits.

You can override policy when creating a session if needed, but the defaults are safe for most workflows.

## Environment Cheat Sheet

| Variable             | Typical values           | Purpose                                               |
| -------------------- | ------------------------ | ----------------------------------------------------- |
| `ORG_PAGER`          | `delta`, `less`, `cat`   | Force a specific pager for `session.patch`.           |
| `ORG_REVIEW`         | `ask`, `auto`, `never`   | Patch review mode (defaults to interactive on a TTY). |
| `ORG_PROJECT_DIR`    | `/path/to/repo`          | Operate on a repo without `cd` (alternate to `-C`).   |
| `ORG_COMMIT_ENABLED` | `true`/`false`           | When true org will commit to your repostiroy any approved patches   |
| `ORG_SAFE_MODE`      |`1`/`true`                | Extra confirmation gates for shell & writes.          |