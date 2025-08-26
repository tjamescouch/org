


<xaiArtifact artifact_id="9a3b0310-ab0a-41ca-ab25-11ce60a16d98" artifact_version_id="a78fb826-83c8-457e-a017-3a75324f48f7" title="PORTFOLIO.md" contentType="text/markdown">

# org

This portfolio showcases `org`’s capabilities as a safe, auditable, and collaborative AI-driven CLI for developer and DevOps tasks. Each example includes a prompt you can run with `org`, a description of what it does, and a placeholder for the output (e.g., patches, logs) generated when you execute it. We’ll link to artifacts in the `examples/` directory once they’re added to the repository. Try these prompts in your own repo to see `org` in action!

For setup and usage details, see [README.md](README.md). All examples assume a clean Git tree and a local LLM (e.g., LM Studio or Ollama) running at `http://127.0.0.1:11434`.

## Contents
- [Example 1: Writing a File with a Single Agent](#example-1-writing-a-file-with-a-single-agent)
- [Example 2: Multi-Agent Code and Test Workflow](#example-2-multi-agent-code-and-test-workflow)
- [Example 3: DevOps Script Execution in Sandbox](#example-3-devops-script-execution-in-sandbox)

## Example 1: Writing a File with a Single Agent
**Prompt**:
```bash
org -C ~/myrepo --agents "alice:lmstudio" --max-tools 20 --safe
@alice write “Hello, World!” to hello/hello-world.txt
```

**Description**:
This prompt instructs `alice` to create a directory `hello/` and write “Hello, World!” to `hello-world.txt`. The `--safe` flag ensures a patch is generated and reviewed before applying. The output includes a `session.patch` showing the file creation and logs in `.org/runs/<uuid>/`.

**Output (Placeholder)**:
```text
[Paste the output here after running the prompt, e.g., contents of session.patch, stdout/stderr from .org/runs/<uuid>/steps/step-0.out, etc.]
```

**Artifacts**:
- Once added, link to: `examples/hello-world/session.patch`
- Expected: A Git patch creating `hello/hello-world.txt` with “Hello, World!”.

## Example 2: Multi-Agent Code and Test Workflow
**Prompt**:
```bash
org -C ~/myrepo --agents "alice:lmstudio,bob:lmstudio" --max-tools 50 --safe
@alice scaffold a TypeScript function slug() in src/utils/slug.ts that converts a string to a slug
@@bob write a test for slug() in src/utils/slug.test.ts and run it with bun test
```

**Description**:
This multi-agent workflow showcases collaboration: `alice` creates a `slug` function (e.g., converts “A B” to “a-b”), and `bob` writes and runs a test using Bun. The `--safe` flag ensures patches for both files are reviewed. Outputs are saved in `.org/runs/<uuid>/`, including the patch and test results.

**Output (Placeholder)**:
```text
[Paste the output here after running the prompt, e.g., session.patch for src/utils/slug.ts and src/utils/slug.test.ts, test output from step-N.out, any violations in step-N.violation.txt.]
```

**Artifacts**:
- Once added, link to: `examples/slug-workflow/session.patch`, `examples/slug-workflow/test-output.txt`
- Expected: Patches for `slug.ts` and `slug.test.ts`, plus test logs.

## Example 3: DevOps Script Execution in Sandbox
**Prompt**:
```bash
org -C ~/myrepo --agents "alice:lmstudio" --max-tools 20 --safe --sandbox-backend=podman
@alice run a shell script to list all TypeScript files in src/ and save the output to files.txt
```

**Description**:
This prompt runs a shell command (`find src -name "*.ts" > files.txt`) in a Podman sandbox, ensuring isolation. The `--safe` flag triggers a patch review for `files.txt`. Outputs are saved in `.org/runs/<uuid>/`, including the patch and `sh` tool’s stdout/stderr.

**Output (Placeholder)**:
```text
[Paste the output here after running the prompt, e.g., session.patch for files.txt, stdout from step-0.out showing the find command’s output.]
```

**Artifacts**:
- Once added, link to: `examples/files-list/session.patch`, `examples/files-list/step-0.out`
- Expected: A patch creating `files.txt` with a list of `.ts` files.

## Next Steps
1. Run these prompts in your repo with `org` and paste the outputs into this document.
2. Save generated artifacts (e.g., `session.patch`, `step-N.out`) in the `examples/` directory and update links above.
3. Share your results on X or Reddit (e.g., r/LocalLLM) to show `org` in action!
4. Contribute new examples or tools by opening a PR—see [CONTRIBUTING.md](CONTRIBUTING.md) (to be created).

</xaiArtifact>

### Explanation and Next Steps
- **Why This Structure?**:
  - The portfolio highlights `org`’s key features: single-agent tasks, multi-agent collaboration, and sandboxed DevOps workflows. These align with the vision of a “trusted, collaborative AI teammate” from the updated `README.md`.
  - Three examples cover diverse use cases: a simple file write, a code/test workflow (inspired by the `slug.test.ts` example in the README), and a DevOps task to show sandboxing.
  - Placeholders make it easy for you to paste outputs (e.g., `session.patch`, `step-N.out`) after running the prompts.
  - Artifact links anticipate your plan to store outputs in `examples/`, boosting credibility and usability.
- **How to Use**:
  1. Save this `PORTFOLIO.md` in your repo’s root.
  2. Run each prompt in a test repo with `org` (e.g., `~/myrepo` with a clean Git tree and LLM running).
  3. Copy the outputs (e.g., `cat .org/runs/<uuid>/session.patch`, `cat .org/runs/<uuid>/steps/step-0.out`) into the placeholders.
  4. Save artifacts in `examples/` (e.g., `examples/hello-world/session.patch`) and update links in the document.
  5. Commit `PORTFOLIO.md` and `examples/` to your repo.
- **Tips for Success**:
  - **Test Prompts First**: Run the prompts in a sandboxed environment to ensure they produce clean patches and outputs. If errors occur (e.g., policy violations), note them in the output sections for transparency.
  - **Add Visuals**: Include screenshots or GIFs of the patch review process (e.g., `delta` output) in `PORTFOLIO.md` to make it engaging.
  - **Promote It**: Share the portfolio on X (e.g., “Check out org’s portfolio: real AI-driven tasks with patches and artifacts! https://github.com/tjamescouch/org #AI #OpenSource”) or r/LocalLLM.
  - **Expand Later**: Add more examples (e.g., debugging `cchat` from earlier READMEs) or invite contributors to submit their own via a `CONTRIBUTING.md`.

### Additional Thoughts
- **Relevance to Your Goals**: The portfolio directly supports your desire to spread the word by showcasing `org`’s practical value. It leverages the multi-agent and sandbox features from the latest README, addressing my earlier feedback about needing more use case examples.
- **Utility Boost**: By showing real outputs (once you run the prompts), the portfolio will prove `org`’s usefulness to devs, especially those skeptical of AI tools due to safety concerns.
- **Contributor Appeal**: The “Next Steps” section and mention of `CONTRIBUTING.md` invite contributions, aligning with your open-source vision (MIT license, collaborative focus).

### Questions for You
- **Prompt Tweaks**: Are the sample prompts (file write, code/test, DevOps script) what you had in mind, or do you want different ones (e.g., debugging, linting)?
- **Output Format**: Do you want specific output formats in the placeholders (e.g., only `session.patch`, or also `manifest.json`)? I can adjust the template.
- **Artifact Plan**: How do you plan to organize `examples/` (e.g., subdirs per example)? I can suggest a structure.
- **Promotion Help**: Want me to draft a social post or `CONTRIBUTING.md` to tie into the portfolio’s release?

