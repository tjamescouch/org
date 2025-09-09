
# Installation (macOS & Linux)

This guide gets you from **zero → running `org`** with a **VM-backed sandbox**.  
On Apple Silicon we use **Lima**; on Intel macOS use **VirtualBox** (or prefer Lima if available).  
Linux can run without a VM (container-only), but the VM path is the recommended hard boundary.

---

## Quick Start (Apple Silicon • macOS)

> Clean, minimal path using Homebrew and `orgctl quickstart`.

```bash
# 1) Install the CLI and VM helpers
brew tap tjamescouch/org
brew install orgctl lima socket_vmnet

# 2) Create + provision the VM, wait until org is installed, then attach
orgctl quickstart --verbose --attach
````

Inside the VM (you’ll see a bright **\[VM]** prompt):

```bash
# Sanity check a run
org --ui console --prompt "hello"
```

**What `quickstart` does on first boot**

* Creates the Lima VM from `.org/config/org.lima.yaml`.
* Provisions the guest (Ubuntu, Bun, Podman optional), sets a **colorful prompt**, and hardens UFW.
* Mounts your host `~/dev` at **`/home/<you>.linux/dev`** (so `~/dev` inside the VM shows your host repos).
* Exposes your host LLM (LM Studio/Ollama) to the guest and sets:

  ```
  ORG_LLM_BASE_URL=http://192.168.5.2:11434
  ```

  (192.168.5.2 is Lima’s alias to the host’s 127.0.0.1; egress is allowed only to that port.)

> First run may take a while (downloads + image build). `--verbose` prints honest progress and dots when it’s still working.

---

## Quick Start (Intel macOS)

VirtualBox works on Intel, but Lima is preferred if you have it:

```bash
brew tap tjamescouch/org
brew install orgctl
# If you don’t have Lima, install VirtualBox instead:
brew install --cask virtualbox
orgctl quickstart --verbose --attach
```

---

## Day-to-day

```bash
# Start / stop / destroy the VM
orgctl vm up
orgctl vm stop
orgctl vm destroy

# Attach a shell in the VM
orgctl vm ssh
```

---

## Networking model (default)

* **Guest egress is denied** by default via UFW, except:

  * loopback (`127.0.0.1`) and
  * **guest → host LLM** on `192.168.5.2:11434` (Lima’s alias to the host loopback).
* The installer sets and persists:

  ```bash
  ORG_LLM_BASE_URL=http://192.168.5.2:11434
  ```

  You can override at any time:

  ```bash
  export ORG_LLM_BASE_URL="http://host.lima.internal:11434"
  ```

---

## Troubleshooting

**Stuck at “Waiting for VM … boot scripts must have finished”**
That’s Lima finishing cloud-init; `quickstart --verbose` keeps printing state lines until `org` is installed. If Lima prints a transient error but SSH becomes ready, `quickstart` continues and will still reach READY.

**“orgctl vm ssh” says no instance / tries the wrong name**
The VM name is `org.lima`. Use:

```bash
limactl list
limactl shell org.lima
```

**VM prompt isn’t colorful**
You’re in a login shell that doesn’t source `~/.bashrc`. Provisioning adds the loader, but if you created the VM earlier, run once inside the VM:

```bash
printf '[ -r ~/.bashrc ] && . ~/.bashrc\n' >> ~/.bash_profile
printf '\nfor f in ~/.bashrc.d/*.sh; do [ -r "$f" ] && . "$f"; done\n' >> ~/.bashrc
exec bash -l
```

**LM Studio/Ollama reachable?**
From the VM:

```bash
curl -sS http://192.168.5.2:11434/api/tags | head
```

If this fails, ensure LM Studio is running on the host and that UFW shows an allow rule:

```bash
sudo ufw status | grep 11434
```

---

## Clean reset (Apple Silicon)

```bash
# Remove the VM
limactl stop org.lima || true
limactl delete -f org.lima || true

# (Optional) wipe Lima caches to force fresh images
rm -rf ~/Library/Caches/lima/*

# Recreate in one go
orgctl quickstart --verbose --attach
```

---

## Container-only (Linux or macOS) — optional tryout

```bash
# Linux example (Debian/Ubuntu)
sudo apt-get update && sudo apt-get install -y podman git
git clone https://github.com/tjamescouch/org.git
cd org
./install.sh
org --ui tmux --prompt "hello"
```

> VM mode is recommended for a stronger boundary and consistent UX, but container-only is handy for quick tests.

---



