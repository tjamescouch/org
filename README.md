![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

# org

_Agentic dev helpers that can "do things" in your repo while you watch, review, and approve every change._

- ✏️ **Conversational**: give a task, the agent plans and executes.
- 🤝 **Collaborative**: works as part of a multi-agent setup, coordinating steps and maintaining a conversation between the agents.
- 🧰 **Tools**: `sh`, `apply_patch`, etc. 100% auditable.
- 🔒 **Safe-by-default**: denylist for dangerous paths; *every* change turns into a patch you review before it lands.
- 🧪 **Deterministic runs**: all stdout/stderr, artifacts, and a git patch are saved under `.org/runs/<id>` for inspection or CI upload.
- 🛡️ **Optional containerized sandbox**: run steps inside a Podman container with no network by default.

> This is a developer productivity tool, not a security boundary. See [SECURITY.md](SECURITY.md) for hardening guidance.

## Vision

Developers and operators deserve AI teammates they can **trust, understand, and control**. Most tools either go fully automated (opaque, risky) or stay passive (just suggest, never act). This project takes a different stance:

* **Dev + DevOps, one CLI**: A single agentic workflow that works for both coding and operations. Write code, run infra, and patch your repo — all inside the same safe loop.
* **Multi-agent as a first-class feature**: Collaboration isn't a bolt-on. Agents can coordinate, debate, and hand off tasks, while you oversee and approve every change.
* **Sandbox + patch review**: Every command runs in isolation. Every file change is surfaced as a patch. Nothing merges until you say so.
* **Safety as a value, not a feature**: Guardrails, glob-based policies, and human-in-the-loop review make it impossible for an agent to "go rogue" in your repo.
* **Composable workflows**: Use it solo as a powerful dev helper, or spin up multiple agents to cover testing, ops, and review simultaneously.

The vision is simple: **an agent CLI that feels like a real teammate — fast, opinionated, and safe.**

## Quick Start

```bash
# 1) From a working repo with a clean git tree:
git status

# 2) Start an agent (uses your local LLM by default)
org --agents "alice:lmstudio" --max-tools 20

# 3) Ask for something small
@alice write "hello world" to a file named hello/hello-world.txt
```

When the tool wants to touch the filesystem, it first produces a **patch**. You can read, approve, or reject it. After approval, the agent continues.

All artifacts for each run land in `.org/runs/<uuid>/` with comprehensive logs and the final patch.

## Installation

See [INSTALLATION.md](docs/INSTALLATION.md) for complete setup instructions.

## Documentation

- **[Installation Guide](docs/INSTALLATION.md)** - Complete setup for macOS and Linux
- **[Configuration](docs/CONFIGURATION.md)** - LLM settings, environment variables, and options
- **[Usage Guide](docs/USAGE.md)** - CLI options, examples, and common workflows
- **[Architecture](docs/ARCHITECTURE.md)** - How it works under the hood
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions
- **[Testing](docs/TESTING.md)** - Running and writing tests

## License

MIT