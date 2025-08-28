# INSTALLATION.md

This document explains how to install **org** so you can run it from anywhere on your machine.
It covers macOS (Apple Silicon/Intel) and Debian/Ubuntu‑like Linux.

---

## What you’ll end up with

* A container image named **`localhost/org-build:debian-12`** that contains all the runtime bits (Bun, tmux, etc.).
* A command named **`org`** on your `$PATH` that launches the app (and will always point back to your local repo).
* A utility named **`apply_patch`** on your `$PATH` that safely applies AI‑generated patches.

The installation is *non-destructive*: no system libraries are modified, and everything can be uninstalled cleanly.

---

## Prerequisites

### macOS

* **Podman** (preferred)

  ```bash
  brew install podman
  podman machine init    # first time only
  podman machine start
  ```

  > Docker can work too, but the scripts assume `podman` by default.

* **git** (via Xcode Command Line Tools or Homebrew).

### Debian/Ubuntu

* **Podman**

  ```bash
  sudo apt-get update
  sudo apt-get install -y podman
  ```
* **git**

> If your Podman is inside a VM (macOS), make sure `podman machine start` completes without errors before continuing.

---

## 1) Clone the repository

```bash
git clone https://github.com/tjamescouch/org.git org
cd org
```

> Throughout this guide, we assume you’re running commands from the repository root.

---

## 2) Build (or rebuild) the runtime container

You can use the helper script exactly as written:

```bash
./create-container.sh
```

The script does a clean, no‑cache Podman build for the **`localhost/org-build:debian-12`** image and then sanity‑checks that the container exposes the expected path setup (it echoes `"$PATH"` from inside the image).&#x20;

If you prefer the raw command:

```bash
podman build --no-cache --platform linux/arm64 \
  -t localhost/org-build:debian-12 -f Containerfile .
```

> On Intel hosts, use `--platform linux/amd64`. If you omit `--platform`, Podman will pick a sensible default for your machine.

---

## 3) Install the CLI shims

Run the installer from the repo root:

```bash
./install.sh
```

What it does:

* **Copies** `apply_patch` to `/usr/local/bin/apply_patch` (so it’s always available even outside the repo).
* **Symlinks** `/usr/local/bin/org` → `<your-repo>/org`, so `org` always runs the file inside your working tree.
* Sets your repo’s git hooks path to `.githooks` and makes the pre‑commit hook executable.

You’ll see messages like:

```
[install.sh] Installed apply_patch -> /usr/local/bin/apply_patch
[install.sh] Symlinked org -> /usr/local/bin/org -> <repo>/org
...
[install.sh] Done. Run 'org' from ANY directory; agents operate in that directory.
```

All of the above is exactly what `install.sh` encodes.&#x20;

> If `/usr/local/bin` is not writable, you’ll be prompted for `sudo`.
> If your shell uses a custom `$PATH`, ensure `/usr/local/bin` precedes system locations.

---

## 4) Quick verification

From **any** directory:

```bash
org --prompt "say hi"
```

You should see a short interactive run. Logs live under the current project’s `.org/logs/` directory. For example:

```bash
tail -f ./.org/logs/last.log
```

To try the tmux integration (runs the console UI *inside* a tmux pane in the container):

```bash
org --ui tmux --prompt "hi there"
```

---

## 5) Day‑to‑day usage (basics)

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

---

## 6) Upgrading & maintenance

* **Update the code**:

  ```bash
  git pull
  ```
* **Rebuild the container** (when the `Containerfile` changes or dependencies are updated):

  ```bash
  ./create-container.sh
  ```

  (Clean rebuild with `--no-cache` is already baked into the script.)&#x20;
* **Update the shims** (if `org` or `apply_patch` changed):

  ````bash
  ./install.sh
  ``` :contentReference[oaicite:3]{index=3}
  ````

---

## 7) Uninstall

* Remove the shims:

  ```bash
  sudo rm -f /usr/local/bin/org /usr/local/bin/apply_patch
  ```
* Remove the container image (optional):

  ```bash
  podman rmi localhost/org-build:debian-12
  ```
* Remove any project artifacts `.org/` in your repos (logs, session data) as desired.

---

## Troubleshooting

**“Cannot connect to Podman socket” (macOS)**
`podman machine start` (or `init` first time) and retry. If you switched shells/terminals, ensure `$PATH` includes Homebrew’s Podman.

**`org: entrypoint not found: .../src/app.ts`**
The launcher couldn’t locate the project’s entry. Make sure you are on the correct branch and that the repository contains `src/app.ts`. If you’re testing from an ephemeral temp folder, ensure the repo tree is present (the launcher runs inside the *current project*, not the tool’s repo).

**tmux “flashes” and exits**
Open the newest log under `.org/logs/tmux-*.log` in the project you launched from:

```bash
ls -lt .org/logs/tmux-*.log | head
tail -n +1 -f .org/logs/tmux-*.log
```

Look for an app error just before exit.

**Shell completion / not found**
If your shell says `org: command not found` right after installing, you likely need to refresh your PATH or start a new terminal session.

---

## Notes on files created

* **`/usr/local/bin/org`** — symlink to `<repo>/org` (installed by `install.sh`).&#x20;
* **`/usr/local/bin/apply_patch`** — a copy of the repo’s `apply_patch` script (installed by `install.sh`).&#x20;
* **`.org/logs/`** under *your project* — rotating run/tmux logs.
* **Container image** — `localhost/org-build:debian-12` in your Podman local image store (built by `create-container.sh`).&#x20;

---

## Appendix: One‑liner (first‑time macOS setup)

```bash
brew install podman && podman machine init && podman machine start
git clone https://github.com/tjamescouch/org.git org && cd org
./create-container.sh
./install.sh
org --prompt "hello"
```

If anything fails, revisit the sections above for detail.

---

Happy hacking! If you run into trouble not covered here, capture `.org/logs/*` from the project you’re working in and open an issue with the log snippet.
