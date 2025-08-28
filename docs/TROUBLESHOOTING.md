# Troubleshooting

## Common Issues

### "No patch produced"

* The command didn't change tracked files (e.g., listing or printing only).
* The write policy denied the path → see `.org/runs/<id>/steps/step-N.violation.txt`.
* The change was staged under `.org/` or `.git/` (ignored from patches).

### Root-level files don't show up

* Ensure policy includes both `'*'` (top-level) **and** `'**/*'` (nested).
* If the file is ignored by `.gitignore`, we still force-add it when allowed.

### Patch viewer "what do I press?"

* It's a pager (`delta` or `less`). **q** to quit, then you'll see:
  `Apply this patch? [y/N]`. Press **y** (Enter) to apply.

### "Trying to pull localhost/org-build:debian-12"

* Build or tag the base image locally:
  `podman tag debian:12 localhost/org-build:debian-12`.

### Heartbeat dots over the patch screen

* By design they're suppressed during review; if you still see them, make sure you're on the current build with heartbeat suppression enabled.

## Platform-Specific Issues

### "Cannot connect to Podman socket" (macOS)

`podman machine start` (or `init` first time) and retry. If you switched shells/terminals, ensure `$PATH` includes Homebrew's Podman.

### `org: entrypoint not found: .../src/app.ts`

The launcher couldn't locate the project's entry. Make sure you are on the correct branch and that the repository contains `src/app.ts`. If you're testing from an ephemeral temp folder, ensure the repo tree is present (the launcher runs inside the *current project*, not the tool's repo).

### tmux "flashes" and exits

Open the newest log under `.org/logs/tmux-*.log` in the project you launched from:

```bash
ls -lt .org/logs/tmux-*.log | head
tail -n +1 -f .org/logs/tmux-*.log
```

Look for an app error just before exit.

### Shell completion / not found

If your shell says `org: command not found` right after installing, you likely need to refresh your PATH or start a new terminal session.

## Policy and Security

### Root-level file didn't appear

Ensure your allow list includes **both** `'*'` (top-level) **and** `'**/*'` (nested). This is the default policy; verify with:

```bash
jq '.spec.write' .org/runs/*/manifest.json | tail -1
```

### Policy violations

Check for violation files:

```bash
ls .org/runs/*/steps/*violation.txt 2>/dev/null || echo "no violations"
```

Each violation file contains details about what path was blocked and why.

## Debugging

### Enable debug logging

```bash
export ORG_DEBUG=1
# or
export LOG_LEVEL=debug
```

### View recent logs

```bash
tail -f .org/logs/last.log
```

### Inspect run artifacts

```bash
# Find the most recent run
RUN="$(ls -d .org/runs/* 2>/dev/null | sort | tail -1)"

# View the manifest
jq . "$RUN/manifest.json"

# Check for errors in steps
ls "$RUN"/steps/*.err 2>/dev/null | xargs -r tail -n +1

# View the final patch
cat "$RUN/session.patch"
```

## Getting Help

If you run into trouble not covered here:

1. Capture logs from `.org/logs/*` in the project you're working in
2. Include the output of `jq . .org/runs/*/manifest.json | tail -20`
3. Note your platform (macOS/Linux), Podman version, and the command that failed
4. Open an issue with the log snippet and context