# Testing

## Running Tests

```bash
bun test
```

## Test Coverage

We include tests that exercise:

### Unit Tests

* **`TagSplitter`**: token allowlist (`agentTokens`, `userTokens`, `fileTokens`), whitespace/Unicode, single-`@`/`#` options.
* **`LLMNoiseFilter`**: single & cross-chunk sentinels, fenced blocks, **no duplication on flush**.
* **`LockedDownFileWriter`**: relative-only paths, traversal rejection, `.org/.git` denial, atomic write, size caps.

### Integration Tests

* **Routing**: explicit tag preempts and runs next tick; default DM to requester; group fallback.
* **File handling**: two `##file:PATH` blocks in one message → disk contains only the last block; processed once.
* **Sandbox policy**: deny overrides allow; violations revert step commit and create `steps/step-N.violation.txt`.
* **Patch apply**: add/modify/delete/rename + CRLF cases across both apply modes.

### System Tests

* **Glob & policy** — `matchAny` semantics; deny-over-allow; top-level vs nested.
* **Patch generation** — root & nested files produce headers with `a/` & `b/` prefixes (`-c diff.noprefix=false`).
* **Streaming/heartbeat** — baseline behavior + suppression while UI is up.

## Test Organization

Tests are located alongside the source files they test:

```
src/
├── utils/
│   ├── llm-noise-filter.ts
│   └── llm-noise-filter.test.ts
├── tools/
│   ├── file-writer.ts
│   └── file-writer.test.ts
└── ...
```

## Writing Tests

### Unit Test Example

```typescript
import { expect, test } from "bun:test";
import { LLMNoiseFilter } from "./llm-noise-filter";

test("strips sentinels while preserving fenced blocks", () => {
  const filter = new LLMNoiseFilter();
  const input = "<|channel|>noise<|message|>```\ncode\n```";
  const result = filter.feed(input) + filter.flush();
  expect(result).toBe("```\ncode\n```");
});
```

### Integration Test Guidelines

* Test the actual behavior users will see
* Use temporary directories for file system tests
* Mock external dependencies (LLM APIs, containers)
* Verify both success and error paths

### System Test Principles

* Test end-to-end workflows
* Verify artifact generation and cleanup
* Test policy enforcement in realistic scenarios
* Ensure graceful handling of edge cases

## Test Data

Test fixtures are organized under `test/fixtures/`:

```
test/
├── fixtures/
│   ├── sample-repo/
│   ├── patches/
│   └── config/
└── helpers/
    └── test-utils.ts
```

## CI Integration

Tests run automatically on:
- Pull requests
- Main branch commits
- Release tags

All tests must pass before merging.