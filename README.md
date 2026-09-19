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
│   ├── python-tooling.md       # Python development toolchain (uv, ruff, ty, REPL, QA gates)
│   └── skills-backlog.md       # Evaluated candidate skills backlog
├── skills/                     # Reusable procedural skills (Agent Skills standard)
│   ├── analyze-sessions/       # Tools for querying sessions, costs, and reflection
│   ├── deep-engineering/       # Architectural design, domain modeling, and root-cause debugging
│   ├── discover-standards/     # User-guided extraction of codebase patterns into local rules
│   ├── how/                    # Read-only architectural walkthroughs and runtime mental models
│   ├── html2md/                # HTML to Markdown conversion tool
│   ├── idea-refine/            # Structured divergent/convergent ideation framework
│   ├── make-skill/             # Meta-skill for scaffolding new standardized skills
│   ├── reflect/                # Extracts learnings from session corrections to evolve agent rules
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
│   ├── context-monitor/        # Live footer token & context percentage badge and /tokens command
│   ├── git-checkpoint/         # Manual, durable working tree snapshots (/checkpoint, /rollback)
│   ├── gondolin/               # Sandboxes execution inside an isolated Linux micro-VM (/gondolin)
│   ├── neovim/                 # Live Neovim editor context and buffer awareness
│   ├── pi-repl/                # Python eval & type introspection against active uv environment
│   ├── prompt-snippets/        # Toggleable prompt fragments (alt+s, /snippets)
│   ├── secrets-guard/          # Intercepts sensitive reads, env dumps, and enforces workspace jailing
│   └── subagents/              # Declarative subagent factory (py_explore, explore, git_commit, /subagents)
├── prompts/                    # Ephemeral task templates and slash commands
├── packages/                   # Composable bundles referencing root primitives
│   └── core/                   # Baseline pack (all general agent skills)
│       └── package.json
└── justfile                    # Operational automation recipes
```

---

## Pi Agent Harness Architecture & Philosophy

This repository implements a **modern, token-defensive, terminal-native harness** for Pi Agent. Instead of relying on monolithic system prompts or heavy agent frameworks, it pairs composable Unix-style primitives with targeted safety and context-management layers:

```text
┌────────────────────────────────────────────────────────┐
│ 1. LAYERED PROMPT HIERARCHY                           │
│    Base Persona (agents/base.agent.md)                 │
│      ↳ Session Flavors (flavors/*.md)                  │
│         ↳ On-Demand Skills (skills/*)                  │
│            ↳ Turn Snippets (pi-extensions/prompt-snippets)│
├────────────────────────────────────────────────────────┤
│ 2. TOKEN-DEFENSIVE PLUMBING                           │
│    justfile.agent (capped view/grep/test filters)      │
│    context-monitor (live status badge & /tokens)       │
│    lsp (unified LSP semantic code intelligence)        │
├────────────────────────────────────────────────────────┤
│ 3. ENVIRONMENT & SAFETY GUARDS                         │
│    secrets-guard (workspace jailing & credential block)│
│    bash-guard (interactive prompt vs headless block)   │
│    gondolin (QEMU/KVM micro-VM sandbox & proxy)        │
│    pi-repl (uv-bound python runtime evaluation)        │
│    git-checkpoint (clean snapshots & rollbacks)        │
└────────────────────────────────────────────────────────┘
```

### Layer 1: Layered Prompt Hierarchy (Additive & Lean)
* **Base Persona ([`agents/base.agent.md`](agents/base.agent.md))**: Linked globally (`~/.pi/agent/AGENTS.md`). Sets the always-on tone: clear, concise, actionable communication with zero fluff.
* **Session Flavors ([`flavors/`](flavors/))**: Fixed per-session overlays passed via `just pi <flavor>...` (e.g. `plan`, `rapid`, `python`, `full`) to adapt the agent's posture without touching the base persona.
* **On-Demand Skills ([`skills/`](skills/))**: Procedural, specialized workflows (e.g. `deep-engineering`, `session-handoff`, `analyze-sessions`) loaded by the agent only when requested.
* **Turn-Level Snippets ([`prompt-snippets`](pi-extensions/prompt-snippets/))**: Granular, single-message prompt wrappers toggled on the fly via `Alt+S` or `/snippets` (e.g. *Delegate exploration*, *Orchestrator mode*).

### Layer 2: Token-Defensive Plumbing (Context Preservation)
* **Controlled Discovery & Slices ([`templates/justfiles/justfile.agent`](templates/justfiles/justfile.agent))**: Forbids dumping large raw outputs (`cat`, `pytest`, `find .`). Forces line-capped views, failure-only test reports, and concise linter outputs to preserve the active context window.
* **Context Monitoring ([`context-monitor`](pi-extensions/context-monitor/))**: Live footer status badge (`ctx: 32k/128k (25%)`) and `/tokens` inspection that enables proactive manual compaction (`/compact`) around 40% before LLM attention degrades.
* **Semantic Code Intelligence ([`lsp`](pi-extensions/lsp/))**: Dual-backend Language Server Protocol bridge (`lsp_definition`, `lsp_references`, `lsp_symbols`, `lsp_call_hierarchy`, `lsp_hover`, `lsp_diagnostics`) routing to Neovim RPC when attached or standalone headless JSON-RPC stdio.

### Layer 3: Environment & Safety Guards (Surgical Execution)
* **Secrets & Workspace Jailing ([`secrets-guard`](pi-extensions/secrets-guard/))**: Intercepts sensitive dotfiles (`.bashrc`, `.ssh`, `.env`), credential dumps (`env`, `printenv`), and enforces strict workspace containment across all tools (`read`, `grep`, `find`, `ls`, `bash`).
* **Shell Interception ([`bash-guard`](pi-extensions/bash-guard/))**: Parses bash tool calls with shell-aware AST. Provides interactive confirmation for risky commands in main sessions, and automatic hard-blocking of catastrophic operations in headless subagents (`PI_SUBAGENT_DEPTH >= 1`).
* **Micro-VM Sandboxing ([`gondolin`](pi-extensions/gondolin/))**: Runs operations inside an isolated Alpine micro-VM with an outbound HTTP proxy filter. Automatically bypasses nested VM creation when executing subagents.
* **Python Runtime Inspection ([`pi-repl`](pi-extensions/pi-repl/))**: Evaluates snippets and introspects type signatures directly against the active project's `uv` environment without writing throwaway test files.
* **Durable Checkpoints ([`git-checkpoint`](pi-extensions/git-checkpoint/))**: Fast working-tree snapshots (`/checkpoint`, `/rollback`) before high-variance multi-file refactors.

---

## Bundled Catalog Subagents

Pre-configured subagents available via the [`subagents`](pi-extensions/subagents/) extension:

| Subagent / Tool | Model | Thinking | Tools Whitelist | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **`py-explore`** (`py_explore`) | `deepseek/deepseek-v4-flash` | `1` (Fast) | `read, grep, find, py_inspect, bash` | Fast Python structural & dependency investigator |
| **`explore`** (`explore`) | `deepseek/deepseek-v4-flash` | `1` (Fast) | `read, grep, find` | Polyglot code searcher and symbol locator |
| **`reviewer`** (`reviewer`) | `deepseek/deepseek-v4-flash` | `2` (Reasoning) | `read, grep, find, py_inspect` | Critical code review, boundary analysis & regression checks |
| **`git-commit`** (`git_commit`) | `deepseek/deepseek-v4-flash` | `1` (Fast) | `read, grep, find, bash` | Intelligent Conventional Commit clusterer |

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

## Self-Improvement & Incremental Reflection Workflow

The harness implements a **two-tier incremental learning architecture** to turn friction into permanent improvements without bloating global prompts or causing cross-project pollution:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. DAILY IN-SESSION LEARNING (Any project, any directory)                   │
│    Trigger: Type `reflect` in chat after a task or correction               │
│                                                                             │
│    • Scope: Universal / Harness-Portable.                                   │
│    • Target: Strictly local `./AGENTS.md` in the current project root.      │
│    • Why: 100% safe. Captures repo-specific conventions, domain logic, and │
│      local environment ports without polluting other projects.              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       │ (Pi session transcripts accumulate
                                       │  in ~/.pi/agent/sessions/)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. CENTRAL CATALOG CURATION (Pi-Powered Macro Reflection)                   │
│    Command: `just reflect [timespan]` (Run from this repository)            │
│                                                                             │
│    • Scope: Pi-Native Automation.                                           │
│    • Extraction: Mines human corrections across all Pi sessions from        │
│      ~/.pi/agent/sessions/ via local Python parsing (`prompts.py`).         │
│    • Target Routing:                                                        │
│      - Universal baseline rules ──> `agents/base.agent.md` (kept minimal)   │
│      - Language/Stack standards ──> `flavors/python.md`, `flavors/<lang>.md`│
│      - Multi-step playbooks     ──> New `skills/<name>/SKILL.md`            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Running Macro Reflection in Pi

To evolve your central personas, flavors, and catalog skills based on real corrections across all Pi projects over the last month:

```bash
# Run 30-day reflection from this repository
just reflect 30d
```

This launches a dedicated Pi session that groups recurring friction points from `~/.pi/agent/sessions/` and proposes additive diffs for your confirmation before committing.

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
