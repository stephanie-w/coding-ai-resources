# Target Mappings Reference

Maps discovered learnings and corrections to the appropriate instruction destination in the agent harness.

---

## Target Hierarchy

```text
Standard Agent Environment
├── Local Workspace (Project Scope)
│   ├── ./AGENTS.md                         # Project-specific domain rules, ports, local tooling
│   └── .agents/skills/<name>/SKILL.md      # Project-specific procedural skills (or skills/<name>/)
│
└── Global User Harness (Cross-Project Baseline)
    ├── ~/.pi/agent/AGENTS.md               # Global persona & universal engineering rules (kept lean)
    └── ~/.pi/agent/skills/<name>/SKILL.md  # Global procedural skills
```

---

## Target Routing by Scope & Category

### 1. Local Project Rules (Default)
*Specific to the active codebase, domain, or team setup.*

| Learning Type | Target File | Target Section |
| :--- | :--- | :--- |
| Database / Local Ports | `./AGENTS.md` | `## Environment & Tooling` |
| Business Domain Logic | `./AGENTS.md` | `## Domain Rules` |
| Repository Testing Protocols | `./AGENTS.md` | `## Testing Protocols` |
| Project-Specific Conventions | `./AGENTS.md` | `## Conventions` |

---

### 2. Universal Operational & Behavioral Baseline
*Applies universally across all projects and languages.*

| Learning Type | Target File | Target Section |
| :--- | :--- | :--- |
| Conciseness / Fluff Reduction | `~/.pi/agent/AGENTS.md` | `## Communication Style` |
| Verification Gate / Testing Gate | `~/.pi/agent/AGENTS.md` | `## Operational Rules` |
| Safe Tool Execution | `~/.pi/agent/AGENTS.md` | `## Safe Execution` |
| Commit Hygiene / Git Workflow | `~/.pi/agent/AGENTS.md` | `## Commit Hygiene` |

> [!IMPORTANT]
> **Base Persona Preservation**: Never add language-specific, framework-specific, or verbose rules to `~/.pi/agent/AGENTS.md`. The global persona must stay lean and minimal to prevent context bloat.

---

### 3. Reusable Skills (Playbooks & Workarounds)
*Non-trivial multi-step procedures or non-obvious fixes.*

| Criteria | Route | Action |
| :--- | :--- | :--- |
| Non-obvious debugging (>10m investigation) | **New Skill** | Scaffold `.agents/skills/<name>/SKILL.md` (or `skills/<name>/`) |
| Reusable migration / setup playbook | **New Skill** | Scaffold `.agents/skills/<name>/SKILL.md` |
| Simple preference / single rule | **Local / Global Rule** | Append bullet item to existing section in `AGENTS.md` |

---

## Section Identification & Formatting Standards

1. **Section Selection Priority**:
   - Locate the most specific existing section (e.g. `## Testing Protocols`, `## Commit Hygiene`, `## Code Style`).
   - If no exact match exists, append under `## Heuristics` or `## Operational Rules`.
   - Never create duplicate top-level headers.

2. **Formatting Standard**:
   - Always append as a clean markdown bullet item:
   ```markdown
   * **[Rule Title]**: Detailed rule statement and rationale.
   ```

3. **Conflict Detection**:
   - Before proposing a diff, verify the new rule does not contradict existing directives.
   - If a conflict is found, prompt the user explicitly to choose between overriding or refining the existing rule.

---

## Polyglot Examples

### Example 1: Local Project Rule (Daily In-Session)
- **Signal**: *"In this service, always run database migrations on port 5433."*
- **Target**: `./AGENTS.md` (`## Environment & Tooling`)
- **Addition**:
  ```diff
  + * Database migrations and local testing must use Postgres port 5433.
  ```

### Example 2: Local Language Standard (Project QA)
- **Signal**: *"Always run pytest and ruff through uv run, never call them bare."*
- **Target**: `./AGENTS.md` (`## Testing & Tooling`)
- **Addition**:
  ```diff
  + * Always invoke test runners and linters via `uv run` (e.g. `uv run pytest`, `uv run ruff check`).
  ```

### Example 3: Universal Engineering (Global Persona Update)
- **Signal**: *"Stop creating multi-line commits without summary headers."*
- **Target**: `~/.pi/agent/AGENTS.md` (`## Commit Hygiene`)
- **Addition**:
  ```diff
  + * Follow Conventional Commits format with a concise summary subject line (<72 chars).
  ```

### Example 4: New Standalone Skill
- **Signal**: *"Fixed complex SQLite lock contention under async workers by setting WAL mode and busy_timeout."*
- **Target**: `.agents/skills/sqlite-wal-concurrency/SKILL.md` (or `skills/`)
