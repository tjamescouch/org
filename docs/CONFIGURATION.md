
# Configuration

> **Network model used by this project (today):**  
> The **VM** is the hard boundary. The container runs rootless Podman with **egress only** and is intended to talk **only to the host LLM** exposed at **`192.168.5.2:11434`** (Lima’s host address).  
> If you’re not using Lima, override the base URL accordingly.

---

## LLM Settings

Set these to point the app at your local or remote model server.

| Variable                 | Default                              | Notes                                                                 |
| ------------------------ | ------------------------------------ | --------------------------------------------------------------------- |
| `ORG_LLM_DRIVER`         | `lmstudio`                           | Driver key (e.g., `lmstudio`, `ollama`, `mock`).                      |
| `ORG_LLM_PROTOCOL`       | `openai`                             | Wire format; OpenAI-compatible for LM Studio / Ollama.                |
| `ORG_OPENAI_BASE_URL`    | `http://192.168.5.2:11434/v1`        | Host LLM endpoint reachable **from inside the VM/container**.         |
| `ORG_LLM_PORT`           | `11434`                              | Only used to derive a default when `ORG_OPENAI_BASE_URL` is unset.    |
| `ORG_LLM_MODEL`          | *(driver default)*                   | Model id (driver-specific; e.g., `openai/gpt-oss-120b` in LM Studio). |

> If `ORG_OPENAI_BASE_URL` is not set, the driver will derive `http://192.168.5.2:${ORG_LLM_PORT}/v1` when running in the VM.  
> If you instead expose the LLM inside the VM loopback (e.g., via a reverse SSH tunnel), set `ORG_OPENAI_BASE_URL=http://127.0.0.1:${ORG_LLM_PORT}/v1`.

---

## Environment Variables

| Variable         | Default     | Notes                                                                 |
| ---------------- | ----------- | --------------------------------------------------------------------- |
| `ORG_SAFE_MODE`  | *(unset)*   | `1/true/yes` adds confirmation gates for shell & writes.              |
| `ORG_DEBUG`      | *(unset)*   | `1/true` enables extra debug traces.                                  |
| `ORG_ENGINE`     | `podman`    | Sandbox engine: `podman` \| `docker` \| `none` (prefer `podman` in VM). |
| `ORG_REVIEW`     | *(tty→ask)* | `ask`, `auto`, or `never` (patch review mode).                        |
| `ORG_PROJECT_DIR`| *(unset)*   | Alternate to `-C/--project`.                                          |

---

## Sandbox Configuration

### Why run in a sandbox?

| Concern / Feature                        | Host (no sandbox) | Rootless container (our sandbox) | VM (recommended hard boundary) |
| ---------------------------------------- | ----------------: | :-------------------------------: | :----------------------------: |
| Perf / startup                           |         ✅ fastest |               ✅ fast              |            ❌ slowest           |
| Reproducibility (pinned toolchain image) |                 ❌ |        ✅ (image pin/digest)       |      ✅ (snapshot + image)      |
| Read-only project view                   |                 ❌ |          ✅ (`/project:ro`)        |      ✅ (mounts you choose)     |
| Controlled write surface (allow/deny)    |         ⚠️ ad-hoc |     ✅ (policy check + revert)     |  ✅ (plus filesystem isolation) |
| **Network posture**                      |                 ❌ | ✅ **egress only** (to LLM host)   |   ✅ (host/Internet isolation)  |
| Cap drops / userns / no-new-privs        |                 ❌ |   ✅ (`--cap-drop=ALL`, keep-id)   |    ✅ via hypervisor boundary   |
| Kernel isolation                         |                 ❌ |      ❌ (shared host kernel)       |       ✅ (separate kernel)      |
| Blast radius for a bad command           |       ❌ host-wide |    ⚠️ bounded to mounted dirs     |     ✅ contained to VM disk     |

You can run tools in a disposable **rootless Podman** container. This improves repeatability and reduces accidental host modifications, while keeping everything auditable.

Enable:

```bash
export ORG_ENGINE=podman
````

**Runtime layout (inside the container)**

```
/project  -> your repo (read-only)
/work     -> a scratch working copy (read-write)
```

We initialize a baseline inside `/work`, and compute a patch against that baseline. The patch and any **newly added** files are copied back to `<repo>/.org/runs/<id>/`.

**Base image**

By default we look for `localhost/org-sandbox:latest`. You can tag or load an image that contains `bash`, `git`, `rsync`, and coreutils:

```bash
podman pull docker.io/library/debian:12
podman tag  docker.io/library/debian:12  localhost/org-sandbox:latest
```

> The repo is bind-mounted; you typically don’t need toolchains baked into the image.

**Network model (this project’s default)**

* VM is the **hard boundary**; it may have no Internet access.
* Container uses Podman **slirp4netns** with egress only and is intended to talk **only** to the host LLM at **`192.168.5.2:${ORG_LLM_PORT}`**.
* Do **not** bind the Mac LLM to `0.0.0.0` unless you understand the exposure; prefer the default Lima host address (`192.168.5.2`) or a reverse-tunnel to `127.0.0.1` inside the VM.

---

## Write Policy

Configure what files the agent may touch:

### Default Policy

```ts
allow: ['*', '**/*'],                 // top-level + nested files/dirs
deny:  ['.git/**', '.org/**', '.env', '**/*.pem', '.github/**']
```

### Key Semantics

* `*` matches **top-level** names; `**/*` matches **nested** paths but **not** top-level. That’s why both appear in `allow`.
* Deny patterns **override** allows.
* The sandbox stages changes while **excluding** `.org/` and `.git/` so the patch only contains project edits.

You can override policy when creating a session if needed, but the defaults are safe for most workflows.

---

## Environment Cheat Sheet

| Variable              | Typical values                | Purpose                                                             |
| --------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `ORG_PAGER`           | `delta`, `less`, `cat`        | Force a specific pager for `session.patch`.                         |
| `ORG_REVIEW`          | `ask`, `auto`, `never`        | Patch review mode (defaults to interactive on a TTY).               |
| `ORG_PROJECT_DIR`     | `/path/to/repo`               | Operate on a repo without `cd` (alternate to `-C`).                 |
| `ORG_COMMIT_ENABLED`  | `true` / `false`              | When `true` org will commit approved patches to your repository.    |
| `ORG_SAFE_MODE`       | `1` / `true`                  | Extra confirmation gates for shell & writes.                        |
| `ORG_OPENAI_BASE_URL` | `http://192.168.5.2:11434/v1` | LLM endpoint from within VM/container (override if not using Lima). |


