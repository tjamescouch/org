## Description
< Enter a description >


## PR Checklist: Sandbox Matrix (8/8 must pass)

> **Pre-flight once per branch**
>
> ```bash
> # make sure the image exists
> ./create-container.sh     # or ./install.sh
>
> # start clean (optional but recommended)
> rm -rf .org/runs .org/logs
> ```
>
> All commands below assume the repo root. Replace `<CMD>` with the command you want the step to run.
> For “env propagation” checks we use `printenv | grep -E '^ORG_TEST=' || echo missing`.

### Legend

* **UI**: `--ui console` or `--ui tmux`
* **Mode**:

  * **non-interactive** → one step, captured output (uses `sandboxedSh`)
  * **interactive** → one interactive step (uses `shInteractive`)
* **Backend**:

  * **none** → no nested container; run directly in the app container
  * **podman** → nested container runner

---

### ✅ 1. console • non-interactive • backend=none

* **Run**

  ```bash
  ORG_TEST=1 LOG_LEVEL=debug SANDBOX_BACKEND=none \
  org --ui console --prompt 'run `printenv | grep -E "^ORG_TEST=" || echo missing`'
  ```

* **Expect**

  * Output contains `ORG_TEST=1`
  * No crash/stacktrace
  * `.org/logs/*` has no “posix\_spawn 'bash'” errors

* [ ] PASS

---

### ✅ 2. console • non-interactive • backend=podman

* **Run**

  ```bash
  ORG_TEST=1 LOG_LEVEL=debug SANDBOX_BACKEND=podman \
  org --ui console --prompt 'run `printenv | grep -E "^ORG_TEST=" || echo missing`'
  ```

* **Expect**

  * Output contains `ORG_TEST=1`
  * No crash/stacktrace
  * A single container session reused across steps (check `podman ps` name is stable)

* [ ] PASS

---

### ✅ 3. console • interactive • backend=none

* **Run**

  ```bash
  ORG_TEST=1 LOG_LEVEL=debug SANDBOX_BACKEND=none \
  org --ui console --prompt 'interactive `printenv | grep -E "^ORG_TEST=" || echo missing`'
  ```

  > If your prompt driver doesn’t support the `interactive` keyword, trigger an interactive step via the UI or your testing harness; the key is to exercise `shInteractive`.

* **Expect**

  * Output contains `ORG_TEST=1`
  * **No** “posix\_spawn 'bash' ENOENT” anywhere

* [ ] PASS

---

### ✅ 4. console • interactive • backend=podman

* **Run**

  ```bash
  ORG_TEST=1 LOG_LEVEL=debug SANDBOX_BACKEND=podman \
  org --ui console --prompt 'interactive `printenv | grep -E "^ORG_TEST=" || echo missing`'
  ```

* **Expect**

  * Output contains `ORG_TEST=1`
  * No “posix\_spawn 'bash' ENOENT”
  * Still only **one** container for the app and **one** nested podman for the step (if you keep nesting enabled); or none if your launcher sets `ORG_SANDBOX_BACKEND=none`

* [ ] PASS

---

### ✅ 5. tmux • non-interactive • backend=none

* **Run**

  ```bash
  ORG_TEST=1 LOG_LEVEL=debug SANDBOX_BACKEND=none \
  org --ui tmux
  ```

  In the tmux pane, run:

  ```
  run `printenv | grep -E "^ORG_TEST=" || echo missing`
  ```

* **Expect**

  * Pane prints `ORG_TEST=1`
  * **ESC** emits the ACK and exits gracefully
  * **Ctrl+C** exits immediately (130)

* [ ] PASS

---

### ✅ 6. tmux • non-interactive • backend=podman

* **Run**

  ```bash
  ORG_TEST=1 LOG_LEVEL=debug SANDBOX_BACKEND=podman \
  org --ui tmux
  ```

  In the pane, run the same `printenv` step.

* **Expect**

  * Pane prints `ORG_TEST=1`
  * ESC ACK works; Ctrl+C exits immediately
  * No “posix\_spawn 'bash' ENOENT”

* [ ] PASS

---

### ✅ 7. tmux • interactive • backend=none

* **Run**

  ```bash
  ORG_TEST=1 LOG_LEVEL=debug SANDBOX_BACKEND=none \
  org --ui tmux
  ```

  In the pane:

  ```
  interactive `printenv | grep -E "^ORG_TEST=" || echo missing`
  ```

* **Expect**

  * Pane prints `ORG_TEST=1`
  * **Typing** must not crash the app (regression test from ESC/Ctrl+C fixes)
  * No “posix\_spawn 'bash' ENOENT”

* [ ] PASS

---

### ✅ 8. tmux • interactive • backend=podman

* **Run**

  ```bash
  ORG_TEST=1 LOG_LEVEL=debug SANDBOX_BACKEND=podman \
  org --ui tmux
  ```

  In the pane:

  ```
  interactive `printenv | grep -E "^ORG_TEST=" || echo missing`
  ```

* **Expect**

  * Pane prints `ORG_TEST=1`
  * No “posix\_spawn 'bash' ENOENT”
  * No extra containers spawned when not intended (depending on your launcher policy)

* [ ] PASS

---

## Add-on checks (tick if relevant to your PR)

* [ ] **ESC ack** works in console & tmux (no double-ACK, no freeze)
* [ ] **Ctrl+C** exits with code 130
* [ ] All step artifacts exist (`.org/runs/<id>/steps/step-*.{out,err,meta.json}`)
* [ ] No “sticky runner” surprises: `/work/.org/org-step.sh` is a fresh copy if the script changed
* [ ] CI logs contain no “posix\_spawn 'bash' ENOENT” or uncaught exceptions

---

## How to use this locally

* Run each command and tick the checkbox.
* If a tmux test fails, open `.org/logs/tmux-*.log` for the run and attach to your PR.
* If a console test fails, attach `.org/logs/*` and the newest `.org/runs/<id>/steps/` files.


