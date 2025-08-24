# Security Policy

This project aims to be safe-by-default, but it is **not a sandbox**. If you run
`org` outside a disposable VM, follow the hardening guidance below.

## Reporting a Vulnerability

Use GitHub’s **“Report a vulnerability”** (Security → Advisories) for
this repository so we can coordinate privately.

Please **do not** open public issues or PRs for vulnerabilities.

Include when possible:
- affected commit or release tag
- environment (OS/VM, backend LLM server, network mode)
- precise reproduction steps and expected/actual behavior
- impact assessment (confidentiality/integrity/availability)

## Scope

In scope:
- This repository’s source, installer scripts, and default tools provided here
  (e.g., `sh`, `apply_patch`) **as wired by this repo**.

Out of scope:
- Third‑party backends (LM Studio, Ollama, OpenAI, etc.), their models, or their
  deployment/configuration.
- Host OS / hypervisor issues unrelated to this code.
- Misconfiguration exposure (e.g., binding LLM servers to `0.0.0.0` on bridged/Wi‑Fi).

## Supported Versions

We provide security fixes for:
- `main` branch
- the **latest tagged release**

Older releases are not maintained.

## Coordinated Disclosure & Timelines

Target timelines (non‑binding, severity‑dependent):
- **Acknowledge** receipt: **≤ 3 business days**
- **Initial triage** / repro attempt: **≤ 7 days**
- **Fix / mitigation / advisory**: **≤ 90 days** from triage (expedited for critical issues)

We prefer **coordinated disclosure**. If active exploitation is suspected, we may
issue an interim public advisory.

## Operational Hardening (Recommendations)

These aren’t required for reporting, but strongly recommended for day‑to‑day use:

- Run inside a **VM** with **host‑only networking**; point `LLM_BASE_URL` to the host‑only IP.
- Keep **safe mode** enabled (`--safe` or `SAFE_MODE=1`) outside disposable environments.
- Treat the `sh` tool as untrusted input; built‑in guards are **heuristics**, not containment.
- Avoid sending secrets to models; `transcript.txt` (now git‑ignored) may contain sensitive data.
- Prefer a dedicated working directory; if you add custom tools, hard‑check that file writes
  cannot escape the working dir via `..` or symlinks.
- Do **not** expose unauthenticated LLM endpoints to untrusted networks; bind to a private
  interface or firewall them.

## Credit

With your permission, we will credit reporters by name/handle in release notes or advisories.
No monetary bounty is offered at this time.