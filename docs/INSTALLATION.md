
# INSTALLATION.md

This guide shows how to install **org** so you can run it from anywhere on your machine.
Covers macOS (Apple Silicon & Intel) and Debian/Ubuntu-like Linux.

---

## Quick Start (recommended)

1. **Install prerequisites**

* **macOS**

  ```bash
  brew install podman git
  podman machine init    # first time only
  podman machine start
  ```

* **Debian/Ubuntu**

  ```bash
  sudo apt-get update
  sudo apt-get install -y podman git
  ```

2. **Clone & install**

```bash
git clone https://github.com/tjamescouch/org.git
cd org
./install.sh
```

> `install.sh` will **build the container image if it’s missing** and install the `org` and `apply_patch` shims.
> If `/usr/local/bin` isn’t writable, it automatically installs into `~/.local/bin` and tells you what it did.

3. **Run it**

* Easiest (no host runtime needed): **tmux mode** runs everything inside the container:

  ```bash
  org --ui tmux --prompt "hello"
  ```

* Or, if you have Bun or Node+tsx on your host:

  ```bash
  org --prompt "hello"
  ```

Logs will appear under the **project you run from** at `.org/logs/`.

---

## What you’ll end up with

* A container image **`localhost/org-build:debian-12`** (Bun, tmux, etc.).
* A command **`org`** on your `$PATH` (symlink back to this repo).
* A utility **`apply_patch`** on your `$PATH` (safe patch applier).

The install is **non-destructive** and easy to remove.

---

## Prerequisites (details)

* **Podman** (preferred). Docker can work, but scripts assume `podman`.
* **git**
* (Optional) **Bun** or **Node+tsx** — only needed if you want to run the **console UI on the host**.
  If you don’t want host runtimes, just use `--ui tmux` and everything runs inside the container.

> macOS users: make sure `podman machine start` completes without errors before continuing.

---

## Building the container (optional)

`install.sh` will **build the image if it’s not present**. If you want to (re)build explicitly:

```bash
./create-container.sh
```

Raw Podman example:

```bash
# Apple Silicon
podman build --no-cache --platform linux/arm64 \
  -t localhost/org-build:debian-12 -f Containerfile .

# Intel
podman build --no-cache --platform linux/amd64 \
  -t localhost/org-build:debian-12 -f Containerfile .
```

---

## Installing the CLI shims (what `install.sh` does)

From the repo root:

```bash
./install.sh
```

It will:

* **Install** `apply_patch` to `/usr/local/bin/apply_patch` (or `~/.local/bin/apply_patch` if `/usr/local/bin` isn’t writable).
* **Symlink** `org` to the repo script:

  * `/usr/local/bin/org` → `<repo>/org` (or `~/.local/bin/org` → `<repo>/org`)
* Build the image if it’s missing.
* Print exactly where it installed things and how to run `org` next.

If it had to fall back to `~/.local/bin`, ensure that directory is on your `$PATH`:

```bash
# bash / zsh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # or ~/.zshrc
exec $SHELL -l
```

---

## Verifying your install

From **any** project directory:

```bash
# Runs the console UI on host if you have Bun or Node+tsx
org --prompt "say hi"

# Or: run inside the container in a tmux pane (no host runtime needed)
org --ui tmux --prompt "say hi"
```

Tail logs from the project:

```bash
ls -lt .org/logs/
tail -f .org/logs/last.log
```

---

## Day-to-day usage

* Run `org` **inside the repo you want to work on** — it treats your current directory as the project root.

* Start with a prompt:

  ```bash
  org --prompt "fix tests"
  ```

* Choose UI:

  * Console (host): `org --ui console`
  * tmux (container): `org --ui tmux`

* Useful env vars:

  * `ORG_DEBUG=1` or `LOG_LEVEL=debug` — extra logs
  * `ORG_FORCE_UI=console|tmux` — default UI preference
  * `ORG_ENGINE=podman` — override engine
  * `ORG_IMAGE=localhost/org-build:debian-12` — override image

> In tmux mode we run the console UI **inside** the container; no Bun/Node required on the host.

---

## Upgrading

```bash
git pull
./install.sh
```

If you changed `Containerfile` and want a fresh image:

```bash
./create-container.sh
```

---

## Uninstall

Remove the shims (whichever location you used):

```bash
sudo rm -f /usr/local/bin/org /usr/local/bin/apply_patch
rm -f "$HOME/.local/bin/org" "$HOME/.local/bin/apply_patch"
```

Remove the container image (optional):

```bash
podman rmi localhost/org-build:debian-12
```

Delete project artifacts (`.org/`) as desired.

---

## Troubleshooting

**“Cannot connect to Podman socket” (macOS)**
Run `podman machine init` (once) then `podman machine start`. Confirm `podman info` works.

**`org: entrypoint not found: …/src/app.ts`**
The launcher couldn’t find the app entry in the project you’re in. Make sure the repo you’re **working on** contains `src/app.ts`, or run `org` from the correct project root.

**tmux starts and exits immediately**
Open the newest `.org/logs/tmux-*.log` in the project you launched from:

```bash
ls -lt .org/logs/tmux-*.log | head
tail -n +1 -f .org/logs/tmux-*.log
```

Check for an error just before exit.

**`org: command not found`**
Open a new terminal or put `~/.local/bin` on your `$PATH` (see “Installing the CLI shims”).

---

## Files created

* **`/usr/local/bin/org`** or **`~/.local/bin/org`** — symlink to `<repo>/org`
* **`/usr/local/bin/apply_patch`** or **`~/.local/bin/apply_patch`** — copy of the repo script
* **`<project>/.org/logs/`** — run & tmux logs for that project
* **Podman image** — `localhost/org-build:debian-12`

---

## One-liner (first-time macOS setup)

```bash
brew install podman git && podman machine init && podman machine start \
&& git clone https://github.com/tjamescouch/org.git && cd org \
&& ./install.sh && org --ui tmux --prompt "hello"
```

