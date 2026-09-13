# Coding AI Resources

A centralized catalog of agentic resources (personas, flavors, skills, instructions, extensions, templates, and installable packages) for AI coding agents such as Pi Agent and GitHub Copilot.

---

## Directory Architecture

The repository follows a two-tier organization model:
1. **Atomic Primitives (Root):** Self-contained building blocks (`agents/`, `flavors/`, `skills/`, `instructions/`, `templates/`, `pi-extensions/`, `prompts/`).
2. **Composition Layer (`packages/`):** Manifests that bundle atomic resources into domain-specific, installable packages.

```text
coding-ai-resources/
├── AGENTS.md                   # Operating notes for this repo (just recipes, conventions)
├── agents/                     # Selectable persona and system prompt definitions
│   ├── base.agent.md           # Default persona: communication, operational rules, baseline engineering
│   └── teach.agent.md          # Teaching persona for dedicated learning sessions
├── flavors/                    # Session-scoped overlays composed at launch (`just pi <flavor>...`)
│   ├── plan.md                 # Read-only planning posture
│   ├── rapid.md                # High-velocity MVP/prototype posture
│   ├── full.md                 # Stateful TODO.md task tracking
│   └── python.md               # Python engineering standards (uv, ruff/mypy/pytest, security)
├── instructions/               # Harness-agnostic policies for Copilot-style agents (.instructions.md + applyTo)
│   ├── python-dev.instructions.md           # uv environment management, pytest, and QA gates
│   ├── task-tracking-basic.instructions.md  # Simple checklist-style TODO.md rules
│   └── task-tracking-full.instructions.md   # Rich stateful thought-process tracking
├── docs/                       # Research, backlogs, and catalogs
│   ├── pi-harness.md           # Persona, flavors, and launcher for Pi sessions
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
│   ├── task-management/        # Structured TODO.md task/epic templates and lifecycle
│   ├── technical-writing/      # Disciplined technical documentation, RFCs, and PR specs
│   ├── unslop/                 # Removes AI writing tells and enforces compact human prose
│   └── why/                    # Forensic investigation into code intent via Git history & ADRs
├── templates/                  # Reusable workspace templates and tooling
│   ├── AGENTS.md               # Standard agent operating protocol and command hygiene
│   └── justfiles/
│       ├── core-agent.just     # Language-agnostic inspection tools (search, view, git-diff)
│       ├── python-uv.just      # Python/uv QA gates (test, lint, fix, typecheck, check)
│       └── justfile.agent      # Standalone all-in-one agent justfile
├── pi-extensions/              # TypeScript native extensions for Pi Agent
│   ├── ask-user-question/      # Interactive user prompts & choices in Pi TUI (upstream: pi-config)
│   ├── bash-guard/             # Intercepts agent bash calls; prompts before destructive commands
│   ├── git-checkpoint/         # Manual, durable working tree snapshots (/checkpoint, /rollback)
│   ├── gondolin/               # Sandboxes execution inside an isolated Linux micro-VM (/gondolin)
│   ├── neovim/                 # Live Neovim editor context and buffer awareness
│   └── prompt-snippets/        # Toggleable prompt fragments (alt+s, /snippets)
├── prompts/                    # Ephemeral task templates and slash commands
├── packages/                   # Composable bundles referencing root primitives
│   └── core/                   # Baseline pack (all general agent skills)
│       └── package.json
└── justfile                    # Operational automation recipes
```

---

## 1. Global Setup (Run Once)

Install your core skills globally so they are available in every terminal and project session across your machine:

```bash
# Install core-pack globally into ~/.pi/agent/settings.json
just install-global

# Make the base persona Pi's global context file (one-time; all sessions)
just link-persona

# Link all Pi extensions globally into ~/.pi/agent/extensions/
just link-extensions
```

---

## 2. Project Setup (Per Repository)

To initialize a Python project workspace with agent tooling and instructions:

```bash
# Target path is mandatory
just setup-python /path/to/your/project
```

This single non-destructive command:
1. Copies `justfile.agent` into the target workspace (preserved if already present).
2. Copies `AGENTS.md` into the target workspace (preserved if already present).

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
3. Directly proposes and commits updates to [agents/base.agent.md](agents/base.agent.md), [instructions/](instructions/), or [flavors/](flavors/).

---

## Justfile Command Reference

| Command | Description |
| :--- | :--- |
| `just` | List all available recipes. |
| `just validate` | Validate all `package.json` manifests using `jq`. |
| `just --dry-run <recipe> <args>` | Preview commands safely without executing them. |
| `just install-global [pack]` | Install a package globally into `~/.pi/agent/settings.json` (default: `core`). |
| `just remove-global [pack]` | Remove a globally installed package. |
| `just setup-python <target>` | Initialize Python workspace with `justfile.agent` and `AGENTS.md` in `<target>`. |
| `just init-project-tools <target>` | Copy `justfile.agent` and `AGENTS.md` into `<target>` (non-destructive). |
| `just reflect [timespan]` | Run cross-project session reflection in a dedicated Pi session (default: `30d`). |
| `just install-pack <pack> <target>` | Install a package locally into a specific project. |
| `just remove-pack <pack> <target>` | Remove a package locally from a project. |
| `just test-pack [pack]` | Run Pi locally with skills loaded from this repository. |
| `just pi [flavor...] [args]` | Launch Pi with `agents/base.agent.md` plus zero or more `flavors/<flavor>.md` overlays. |
| `just link-persona` | One-time: link `agents/base.agent.md` to `~/.pi/agent/AGENTS.md` (global persona). |
| `just link-extensions [ext]` | Link one or all `pi-extensions/` into `~/.pi/agent/extensions/` (default: `all`). |
