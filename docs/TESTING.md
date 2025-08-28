

# Testing

## Running tests

```bash
# all tests
bun test

# watch mode (reruns on file change)
bun test --watch

# run a single file
bun test test/policy-write.test.ts

# filter by test name (regex)
bun test --filter "no-op step"
```

> The test runner is **Bun**. You don’t need Node/Jest/Vitest.

---

## Coverage

If your Bun version supports coverage:

```bash
bun test --coverage
```

This prints a summary to stdout (and may emit V8 JSON coverage artifacts depending on your Bun version). If you need LCOV/HTML reports in CI, you can post-process the V8 output with your preferred toolchain; keeping this repo minimal, we don’t ship extra coverage tooling by default.

---

## What’s tested

### Unit

* **LLMNoiseFilter**: single & cross-chunk sentinels, fenced blocks, **no duplication on flush**.
* **LockedDownFileWriter**: relative-only paths, traversal rejection, `.org/.git` denial, atomic write, size caps.
* **Tag/command parsing utilities** (where applicable): allowlists, Unicode/whitespace behaviors.

### Integration

* **Routing**: explicit tag preempts; default DM to requester; group fallback.
* **File handling**: two `##file:PATH` blocks in one message → disk contains only the last block; processed once.
* **Sandbox policy**: deny overrides allow; violations revert step commit and create `steps/step-N.violation.txt`.
* **Patch apply**: add/modify/delete/rename + CRLF cases across both apply modes.

### End-to-End (E2E)

* **Glob & policy** — `matchAny` semantics; deny-over-allow; top-level vs nested.
* **Patch generation** — root & nested files produce headers with `a/` & `b/` prefixes (`-c diff.noprefix=false`).
* **Streaming/heartbeat** — baseline behavior + suppression while UI is up.
* **Launcher** — `org` script resolves entrypoint correctly in ephemeral repos.

---

## Layout (flat)

All tests live under a **flat** `test/` folder. Fixtures/helpers sit in subfolders:

```
test/
├── e2e.noop-and-deny.test.ts
├── policy-write.test.ts
├── <more>.test.ts
├── fixtures/
│   ├── sample-repo/
│   ├── patches/
│   └── config/
└── helpers/
    └── test-utils.ts
```

> Naming: use `*.test.ts`. For readability, e2e suites often start with `e2e.` (e.g., `e2e.noop-and-deny.test.ts`).

---

## Writing tests

### Unit example

````ts
import { expect, test } from "bun:test";
import { LLMNoiseFilter } from "../src/utils/llm-noise-filter";

test("strips sentinels while preserving fenced blocks", () => {
  const filter = new LLMNoiseFilter();
  const input = "<|channel|>noise<|message|>```\ncode\n```";
  const result = filter.feed(input) + filter.flush();
  expect(result).toBe("```\ncode\n```");
});
````

### Integration guidelines

* Test the behavior users actually see.
* Use temp directories for file system work (clean them up).
* Mock external services (LLMs, network).
* Verify both success and error paths.

### E2E principles

* Test end-to-end flows (launcher → scheduler → artifacts).
* Validate `.org/` artifacts (logs, `steps/`, patches).
* Exercise policy enforcement under realistic file layouts.
* Ensure graceful handling of edge cases & bad input.

---

## E2E prerequisites & hints

* E2E tests **do not require** a real LLM; they use the in-repo mock model.

* If any test attempts to detect/launch a container and you want to stay purely host-local, you can force the backend:

  ```bash
  # Example: bypass podman detection during tests
  SANDBOX_BACKEND=mock bun test
  ```

  (The code path prefers Podman only when it’s available **and** reachable.)

* Many E2E tests spin up **ephemeral repos** in your temp directory. Each ephemeral repo’s logs are written to its own `.org/logs`:

  ```bash
  # After a failure, find the newest tmux/run logs produced during the test:
  fd -a -HI 'tmux-*.log' /var/folders 2>/dev/null | sort -r | head
  fd -a -HI 'run-*.log'  /var/folders 2>/dev/null | sort -r | head

  # Or from a specific path printed in the failure output:
  tail -n +1 -f <TMP_REPO>/.org/logs/*.log
  ```

---

## Common gotchas

* **“entrypoint not found: …/src/app.ts”**
  This means the launcher couldn’t find the project’s entry in the **ephemeral** test repo. Our tests expect the `org` script to resolve correctly even in temp dirs; if you changed the launcher, ensure it still derives APPDIR/ENTRY the same way tests expect (see `.org/launcher/*.sh` and `org`).

* **Podman noise in tests**
  If your machine has Podman but its socket/VM isn’t running, detection may fail noisily. Either:

  * start Podman (e.g., `podman machine start` on macOS), **or**
  * set `SANDBOX_BACKEND=mock` for the test run, as shown above.

* **No output while debugging**
  You can crank logging during tests with:

  ```bash
  LOG_LEVEL=debug ORG_DEBUG=1 bun test --filter "<name>"
  ```

---

## CI

Our CI runs:

* `bun test` on pull requests
* `bun test` on `main`
* (optional) coverage summary if your CI Bun version supports `--coverage`

All tests must pass before merging. If an E2E failure is hard to diagnose from CI logs, reproduce locally and attach the relevant `.org/logs/*` from the temp repo that failed.

---

If anything here is unclear or you find a flaky test, capture the failing test name and the corresponding `.org/logs/*` from its temp repo and open an issue.
