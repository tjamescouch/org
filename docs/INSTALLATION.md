
# INSTALLATION

This guide shows how to install **org** with a **VM-backed sandbox** for safer runs and a reproducible developer experience.

- **Apple Silicon (M-series macOS):** uses **Lima** as the VM backend.
- **Intel macOS:** uses **VirtualBox**.
- Linux notes and a legacy “container-only” path are included at the end.

> If you just need the quick steps, see the README. This doc explains *why* each step exists, how to verify it, and how to troubleshoot.

---

## 0) What gets installed

- A tiny CLI, **`orgctl`**, installed via Homebrew.
- A VM defined by **`.org/config/org.lima.yaml`** (Apple Silicon) or VirtualBox (Intel).
- Inside the VM: minimal Ubuntu, Bun, Podman (optional), and a locked-down firewall (localhost-only by default).
- Your **code** is mounted from the host into the VM at `~/dev` (and `~/scratch` is an in-VM tmpfs).

---

## 1) Prerequisites

### macOS (Apple Silicon – recommended path)
```bash
brew tap tjamescouch/org
brew install org
brew install lima                # VM provider for Apple Silicon
````

> **Why Lima?** VirtualBox is not practically usable on Apple Silicon; Lima wraps Apple’s native virtualization for a fast, light VM.

### macOS (Intel)

```bash
brew tap tjamescouch/org
brew install org
brew install --cask virtualbox   # approve kext if macOS prompts
```

### Linux (Debian/Ubuntu)

You can run `org` directly or bring your own VM/hypervisor. For parity with macOS, QEMU/KVM works well, but is not wired into `orgctl` yet. See **Container-only (legacy)** below if you prefer no VM.

---

## 2) Create and start the VM

From the **repo root** (so `orgctl` finds the checked-in profile at `.org/config/org.lima.yaml`):

```bash
# Apple Silicon (Lima)
./orgctl vm init     # creates & boots the VM from .org/config/org.lima.yaml
# Lima 1.2.x prints boot logs; when it settles, press Ctrl-C to detach.
./orgctl vm ssh      # open a shell inside the VM
```
```bash
# Intel (VirtualBox)
./orgctl vm init
./orgctl vm ssh
```

**What the Lima profile does (Apple Silicon):**

* Root disk **50 GiB**.
* Mount host `~/dev →` guest `~/dev` (sane default; keeps personal files out).
* `~/scratch` is tmpfs for ephemeral work.
* Networking: **no external egress**; UFW allows only `127.0.0.1` (LMStudio/Ollama).
  You can temporarily open HTTPS egress inside the VM if you need to pull images (see Troubleshooting).

---

## 3) Put your code into the VM

Choose one:

```bash
# A) Sync your current checkout (no creds in the VM)
./orgctl app install --from host

# B) Clone inside the VM (HTTPS or SSH agent-forwarding)
./orgctl app install --from git --repo https://github.com/<username>/org.git
# or: ./orgctl app install --from git --repo git@github.com:<username>/org.git  (then use ssh-agent)

# C) Verified tarball (no auth; reproducible)
./orgctl app install --from tar \
  --tar-url https://github.com/<username>/org/releases/download/vX.Y.Z/org-X.Y.Z.tgz \
  --tar-sha256 <sha256>
```

All methods end with the repo at `~/org` (or under `~/dev/…` if you prefer).
`--from host` is the safest default: the VM never sees your Git credentials.
The <username> is either tjamescouch or your username if you forked the repository.

---

## 4) Run and verify

Inside the VM:

```bash
cd ~/dev/your-repo
./install.sh        # This will take a while
org                 # or: org --ui tmux
```

Logs for the project appear under `<project>/.org/logs/…` on your host (because the project dir is mounted).

---

## 5) Day-to-day commands

```bash
# Start or stop the VM
./orgctl vm up
./orgctl vm stop

# Enter the VM shell
./orgctl vm ssh

# Rebuild from scratch (applies updated .org/config/org.lima.yaml)
limactl delete org.lima || true
./orgctl vm init
```

> If you installed `orgctl` via Homebrew earlier, ensure your shell picks the **repo** version while developing:
> `export PATH="$PWD:$PATH"` then `type -a orgctl` should show `./orgctl` first.

---

## 6) Security model (quick read)

* **VM boundary**: separate kernel and disk; only `~/dev` (and tmpfs scratch) are visible in the guest.
* **Default egress**: blocked; only `127.0.0.1` allowed from inside VM (talk to LMStudio/Ollama on host).
* **Safer than host/container**: the VM is the recommended “hard boundary.”
* **Not an air-gap**: the mounted `~/dev` is read/write; treat it as in-scope for hostile code.

> See **SECURITY.md** for vulnerability reporting and hardening tips (read-only mounts, per-project mounts, temporary egress rules, etc.).

---

## 7) Troubleshooting

**I see Lima boot logs and can’t type commands**
That’s normal on Lima 1.2.x during `vm init`. Press **Ctrl-C** to detach; the VM stays up. Then `./orgctl vm ssh`.

**`orgctl vm ssh` says “install VirtualBox” on Apple Silicon**
Your shell is using the Homebrew `orgctl` instead of the repo copy. Run `export PATH="$PWD:$PATH"` or call `./orgctl …`. Check with `type -a orgctl`.

**Where’s my disk space?**
`df -h /` shows the VM’s root disk (50 GiB). `df -h ~/dev` shows your **host** free space—expected because it’s a mount.

**Need to pull a container image in the VM**
Inside the VM:

```bash
sudo ufw allow out 443/tcp
podman pull docker.io/library/alpine:latest
sudo ufw delete allow out 443/tcp
```

**VirtualBox on Apple Silicon?**
Not supported in practice. Use Lima.

---

## 8) Uninstall / clean up

```bash
# Remove the VM (Apple Silicon)
limactl stop org.lima || true
limactl delete org.lima || true

# Remove brew CLI
brew uninstall org
```

VirtualBox users: also remove the VM from VirtualBox if created.

---

## 9) Linux & Container-only (legacy)

You can still run **without a VM** (less isolation):

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y podman git
git clone https://github.com/tjamescouch/org.git
cd org
./install.sh
org --ui tmux --prompt "hello"
```

