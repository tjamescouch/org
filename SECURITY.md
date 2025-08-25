
# SECURITY.md

```markdown
# Security Policy

This project aims to be safe-by-default, but it is **not a sandbox**. If you run
`org` outside a disposable VM, follow the guidance below.

## Reporting a Vulnerability

Use GitHub’s **“Report a vulnerability”** (Security → Advisories) for this
repository so we can coordinate privately.

Please **do not** open public issues or PRs for vulnerabilities.

Include when possible:
- affected commit or release tag
- environment (OS/VM, backend LLM server, network mode)
- a minimal reproduction and expected/actual behavior
- any logs from `.org/runs/<id>/steps/*` and the `session.patch` if relevant

We’ll acknowledge receipt within 5 business days and keep you updated.

---

## Threat model (overview)

- The agent can run **shell commands** (`sh`) and write files via patch review.
- We rely on **human approval** for patch application.
- The optional **containerized sandbox** improves *safety* and *repeatability*,
  but is **not** a hardened escape-proof jail.

---

## Hardening recommendations

These are strongly recommended for day-to-day use:

1. **Run inside a VM**  
   Prefer a small Linux VM with a host-only network. Point `LLM_BASE_URL` to the
   host-only IP to keep the model interface private.

2. **Use the sandbox backend**  
   Set `SANDBOX_BACKEND=podman`. By default we start containers with:
   - read-only bind for `/project` (your repo),
   - a writable `/work` scratch copy,
   - **network disabled**,
   - dropped capabilities and `--userns=keep-id`.
   This shrinks the blast radius for accidental commands.

3. **Keep “safe mode” on**  
   The `--safe` flag (or `SAFE_MODE=1`) preserves additional guardrails. Treat
   the `sh` tool as untrusted input even in safe mode; guards are heuristics.

4. **Review every patch**  
   Never auto-apply changes without reading the patch. Deny patterns override
   allows; keep `.git/**`, `.org/**`, `.env`, `**/*.pem`, `.github/**` denied.

5. **Mind secrets and transcripts**  
   Avoid sending secrets to models. The run directory (`.org/runs/<id>/`) stores
   `transcript.txt` and step outputs; keep the repo private and rotate secrets
   if something leaks.

6. **Prefer dedicated working directories**  
   If you add custom tools, validate they cannot escape the working directory
   via `..` or symlinks.

7. **Keep your LLM endpoint private**  
   Do not expose unauthenticated local model servers to untrusted networks. Bind
   to a private interface or firewall them.

---

## Notes on containerization

- The Podman backend uses a local image `localhost/org-build:debian-12`. If you
  cannot pull images, you can load an offline tarball via `podman load -i …`.
- Containerization is for **safety and reproducibility**, not for strong
  isolation. Treat it as a convenience boundary, not a security boundary.

---

## Credit

With your permission we’ll credit reporters by name/handle in release notes or
advisories. No monetary bounty is offered at this time.
````

If you’d like me to tailor either file to your project’s tone or move any of the new sections elsewhere, say the word and I’ll adjust.