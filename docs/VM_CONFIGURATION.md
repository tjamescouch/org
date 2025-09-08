
````markdown
# VM Guide (Lima / VirtualBox)

This project supports running in a **VM-backed sandbox** for a stronger boundary than host or container alone. The VM path preserves org’s core guarantees (patch-review, artifacts, deny-first policy) while putting a kernel boundary around the run. :contentReference[oaicite:0]{index=0} :contentReference[oaicite:1]{index=1}

---

## Quick Start (Apple Silicon → Lima)

> Prereqs: `brew install lima` (Lima 1.2.x works), repo contains `.org/config/org.lima.yaml`.

```bash
# from the repo root
./orgctl vm init    # creates/starts the Lima VM from .org/config/org.lima.yaml
./orgctl vm ssh     # open a shell in the VM (Lima 1.2.x attaches as your macOS username)
````

Your host `~/dev` is mounted at `~/dev` in the guest. `~/scratch` is tmpfs for ephemeral work. The Lima profile defaults to **no external networking** in Lima and enforces **localhost-only** egress inside the guest via UFW (good match for LMStudio/Ollama).

**Day-to-day:**

```bash
./orgctl vm up
./orgctl vm ssh
# inside VM
cd ~/dev/your-repo && bun install && bun run org --ui console
# when done
./orgctl vm stop
```

---

## Quick Start (Intel → VirtualBox)

On Intel hosts we keep a VirtualBox backend for parity with non-ARM machines. Use the same `orgctl vm …` commands; orgctl auto-selects the backend by architecture.

> Note: on Apple Silicon VirtualBox is not a practical option; use Lima.

---

## Security model (at a glance)

| Layer                       | Boundary Strength | What it protects                                                            |
| --------------------------- | ----------------- | --------------------------------------------------------------------------- |
| Host only                   | ❌ weak            | No isolation; **not** recommended for agents that write/run code.           |
| Rootless container (Podman) | ✅ good            | Read-only source mount + controlled write surface + no network by default.  |
| **VM (Lima/VirtualBox)**    | ✅✅ strongest      | Separate kernel and disk; only the mounts you choose are visible.           |

**VM defaults in this repo**

* **Mounts**: host `~/dev →` guest `~/dev` (sane default so agents only see code, not your whole home).
* **Scratch**: `~/scratch` tmpfs (ephemeral, safe for untrusted outputs).
* **Network**: Lima VM has **no external networking**; UFW allows only `127.0.0.1` for LMStudio/Ollama.
* **Review loop**: all changes still land as patch review before touching your repo.&#x20;

> If you need a tighter box, mount a single project path (e.g., `~/dev/myrepo`), or make the mount read-only and `scp` in changes. For a looser dev box, you can allow outbound to curated hosts only.

---

## Troubleshooting

**“orgctl vm ssh shows VirtualBox message on Apple Silicon”**
You’re invoking the wrong `orgctl` on PATH (old Homebrew copy). Use `./orgctl vm ssh`, or run `type -a orgctl` and prefer the repo’s script.

**Stuck on Lima boot logs**
That’s normal for Lima 1.2.x when starting. Press **Ctrl+C** to detach, then run `./orgctl vm ssh`.

**Can’t find the instance**
`limactl list` to verify `org.lima` exists. Recreate with `./orgctl vm init`.

**Where are my files?**
Inside the VM: your host dev workspace is at `~/dev`. The VM root disk size is what you set in `.org/config/org.lima.yaml` (e.g., `50GiB`); `df -h /` shows that. A mounted host dir will report host free space; that’s expected.

---

## Other VM options

* **Lima (recommended on Apple Silicon)** — lightweight, declarative profiles, integrates neatly with dev workflows.
* **VirtualBox (Intel)** — traditional hypervisor; keeps guest fully air-gapped unless you add shared folders.
* **UTM / Apple Virtualization** — also viable on Apple Silicon if you prefer a GUI; not wired into `orgctl` by default.

---

## How this fits org’s philosophy

* **Human-in-the-loop**: every change is a reviewed patch, regardless of backend.&#x20;
* **Sandbox first**: VM is the “hard boundary”; containers remain available for speed.&#x20;
* **Portable installs**: host-only still works; container/VM paths are documented for safety and repeatability. &#x20;

````

