
Here’s a quick sanity-check list before putting up a PR

### Startup behavior

* `--prompt "do X"` → seeds the run, **no idle prompt** opens.
* `--prompt` (no text) → asks once, then runs; idle prompts allowed if still enabled.
* no `--prompt` → no prompt unless an agent does `@@user` or you press **i**.

### While running

* If an agent emits `@@user`, the scheduler **drains first**, then opens the prompt.
* Idle prompt only fires when:

  * queues are empty,
  * `promptEnabled` is true,
  * **and** the grace window has passed.

### Quick regression guards (nice, tight unit tests)

* `parseArgs("--prompt 'hi'")` sets kickoff string, not boolean.
* `promptEnabled` is `true` only when `args.prompt === true`.
* `RandomScheduler`:

  * does **not** call `askUser` immediately on start when kickoff is a string.
  * calls `drain()` before `askUser` on `@@user`.
  * respects `idleNotBefore` before any idle prompt.

### Manual spot checks

* `org --prompt "write a file"` → should start working, no “You:” line.
* `org --prompt` → single “You:” on start, then continues.
* During long tool output, trigger an `@@user`: no prompt until output stops.

