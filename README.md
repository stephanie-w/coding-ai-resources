# Coding AI Resources

A centralized catalog of agentic resources (skills, agent definitions, instructions, templates, and installable packages) designed for AI coding agents such as Pi Agent, Antigravity, and Herdr multi-agent environments.

---

## Directory Architecture

The repository follows a two-tier organization model:
1. **Atomic Primitives (Root):** Self-contained building blocks (`agents/`, `instructions/`, `skills/`, `templates/`, `pi-extensions/`, `prompts/`).
2. **Composition Layer (`packages/`):** Manifests that bundle atomic resources into domain-specific, installable packages.

```text
coding-ai-resources/
├── agents/                     # Persistent persona and system prompt definitions
│   └── base.agent.md           # Core communication, operational rules, and baseline engineering
├── instructions/               # Always-on rule files and standards
│   ├── python-dev.instructions.md           # uv environment management, pytest, and QA gates
│   ├── task-tracking-basic.instructions.md  # Simple checklist-style TODO.md rules
│   └── task-tracking-full.instructions.md   # Rich stateful thought-process tracking
├── docs/                       # Research, backlogs, and catalogs
│   └── skills-backlog.md       # Evaluated candidate skills backlog
├── skills/                     # Reusable procedural skills (Agent Skills standard)
│   ├── analyze-sessions/       # Tools for querying sessions, costs, and reflection
│   ├── deep-engineering/       # Architectural design, domain modeling, and root-cause debugging
│   ├── discover-standards/     # User-guided extraction of codebase patterns into local rules
│   ├── how/                    # Read-only architectural walkthroughs and runtime mental models
│   ├── html2md/                # HTML to Markdown conversion tool
│   ├── idea-refine/            # Structured divergent/convergent ideation framework
│   ├── make-skill/             # Meta-skill for scaffolding new standardized skills
│   ├── session-handoff/        # Point-in-time state checkpointing and session resume
│   ├── teach/                  # Interactive tutorial and concept onboarding
│   ├── technical-writing/      # Disciplined technical documentation, RFCs, and PR specs
│   ├── unslop/                 # Removes AI writing tells and enforces compact human prose
│   └── why/                    # Forensic investigation into code intent via Git history & ADRs
├── templates/                  # Reusable workspace templates and tooling
│   ├── AGENTS.md               # Standard agent operating protocol and command hygiene
│   └── justfiles/
│       ├── core-agent.just     # Language-agnostic inspection tools (search, view, git-diff)
│       ├── python-uv.just      # Python/uv QA gates (test, lint, fix, typecheck, check)
│       └── justfile.agent      # Standalone all-in-one agent justfile
├── pi-extensions/              # TypeScript/JavaScript native extensions for Pi Agent
├── prompts/                    # Ephemeral task templates and slash commands
├── packages/                   # Composable bundles referencing root primitives
│   ├── core/                   # Baseline pack (all general agent skills)
│   │   └── package.json
│   └── python-dev/             # Dedicated Python/uv development pack
│       └── package.json
└── justfile                    # Operational automation recipes
```

---

## Quick Start: Initializing a Python Project

To initialize a complete Python development environment with agent skills, instructions, and token-optimized inspection tools in a target project:

```bash
# Target path is mandatory
just setup-python /path/to/your/project
```

This single non-destructive command:
1. Installs the `core` pack (`.pi/settings.json`).
2. Installs the `python-dev` pack (enforcing `uv` and `pytest` standards).
3. Copies `justfile.agent` into the target workspace (preserved if already present).
4. Copies `AGENTS.md` into the target workspace (preserved if already present).

---

## Self-Improvement & Reflection Workflow

To evolve your rules and instructions based on real corrections across all projects over the last month:

```bash
# Run reflection from this repository
just reflect 30d
```

This launches a dedicated Pi session that:
1. Mines human corrections from `~/.pi/agent/sessions/` using zero-token local Python extraction.
2. Identifies recurring friction points.
3. Directly proposes and commits updates to [agents/base.agent.md](agents/base.agent.md) or [instructions/](instructions/).

---

## Justfile Command Reference

| Command | Description |
| :--- | :--- |
| `just` | List all available recipes. |
| `just validate` | Validate all `package.json` manifests using `jq`. |
| `just --dry-run <recipe> <args>` | Preview commands safely without executing them. |
| `just setup-python <target>` | Install full Python stack (`core` + `python-dev` + `justfile.agent` + `AGENTS.md`) into `<target>`. |
| `just reflect [timespan]` | Run cross-project session reflection in a dedicated Pi session (default: `30d`). |
| `just install-pack <pack> <target>` | Install a specific package into a target directory. |
| `just remove-pack <pack> <target>` | Remove an installed package from a target directory. |
| `just init-project-tools <target>` | Copy `justfile.agent` and `AGENTS.md` into a target workspace (non-destructive). |
| `just test-pack [pack]` | Run Pi locally with skills loaded from this repository. |
