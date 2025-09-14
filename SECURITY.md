
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

These defaults match the project’s VM-first posture and are recommended for day-to-day use.

1. **Run inside a VM**  
   Prefer a small Linux VM (e.g., Lima). Keep the model private and reachable only from the guest:
   - Set `ORG_OPENAI_BASE_URL` to the Lima host address:
     ```bash
     export ORG_OPENAI_BASE_URL="http://192.168.5.2:11434/v1"
     ```
   - (Alternative) Use a reverse SSH tunnel so the LLM remains on Mac loopback and appears on the VM loopback:
     ```bash
     ssh -F ~/.lima/_config/ssh_config lima-org-lima -N -f -R 11434:127.0.0.1:11434
     export ORG_OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
     ```
   Keep VM firewall/UFW default-deny for outbound except the loopback and the single LLM port you need.

2. **Use the sandbox backend**  
   Set `ORG_ENGINE=podman`. Containers start rootless with:
   - read-only bind for `/project` (your repo),
   - writable `/work` scratch copy,
   - **egress-only networking** via `slirp4netns:allow_host_loopback=true` (no inbound),
   - `--cap-drop=ALL`, `--security-opt no-new-privileges`, and `--userns=keep-id`.
   This keeps changes auditable and shrinks the blast radius for mistakes.  
   > If a task truly needs no network at all, you can run with `--network=none`.

3. **Keep “safe mode” on (optional)**  
   Use `--safe` or `export ORG_SAFE_MODE=1` for additional confirmation gates. Treat any shell tooling as untrusted input even in safe mode; guardrails are heuristics.

4. **Review every patch**  
   Never auto-apply changes without reading the diff. Deny patterns override allows; keep  
   `.git/**`, `.org/**`, `.env`, `**/*.pem`, `.github/**` denied.

5. **Mind secrets and transcripts**  
   Avoid sending secrets to models. Run directories (`.org/runs/<id>/`) contain `transcript.txt` and step outputs—keep the repo private and rotate secrets if something leaks.

6. **Prefer dedicated working directories**  
   If you add custom tools, validate they cannot escape the working directory via `..` or symlinks.

7. **Keep your LLM endpoint private**  
   Do **not** expose unauthenticated local model servers to untrusted networks. For Lima, prefer `192.168.5.2:11434` or the reverse-tunnel/VM-loopback option above. Avoid binding to `0.0.0.0` unless you understand and control the exposure.


---

## Notes on containerization

- The Podman backend uses a local image `localhost/org-sandbox:latest`. If you
  cannot pull images, you can load an offline tarball via `podman load -i …`.
- Containerization is for **safety and reproducibility**, not for strong
  isolation. Treat it as a convenience boundary, not a security boundary.

---

## Credit

With your permission we’ll credit reporters by name/handle in release notes or
advisories. No monetary bounty is offered at this time.
