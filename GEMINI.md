# Repository Instructions & Context

## 1. Baseline Rules & Workflow
Follow all communication, operational, and verification rules defined in:
- [agents/base.agent.md](agents/base.agent.md)

Key constraints:
- **Investigate -> Propose Plan -> Wait for Approval -> Execute.**
- **Collaborative Verification:** Propose exact verification command in the plan; execute upon approval.
- **Concise communication:** Direct, plain language, place the most important information at the end.

## 2. Repository Purpose & Architecture
This repository (`coding-ai-resources`) is a centralized catalog of agentic resources:
- `agents/`: Persistent agent/persona definitions.
- `instructions/`: Continuous standards (`python-dev`, task tracking).
- `skills/`: Reusable capability packages (`analyze-sessions`, `deep-engineering`, `discover-standards`, `how`, `html2md`, `idea-refine`, `make-skill`, `session-handoff`, `teach`, `technical-writing`, `unslop`, `why`).
- `templates/justfiles/`: Token-optimized agent CLI tooling (`justfile.agent`).
- `packages/`: Composition manifests for Pi Agent (`core`, `python-dev`).

## 3. Standard Commands
- `just validate`: Validate all package manifests with `jq`.
- `just --dry-run <recipe> <args>`: Preview commands safely before execution.
- `just setup-python <target>`: Initialize full Python stack in a target project.
