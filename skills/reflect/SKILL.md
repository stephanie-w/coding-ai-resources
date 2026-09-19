---
name: reflect
description: Self-improvement skill that extracts learnings from corrections and success patterns to permanently evolve agent instructions and skills. Trigger on "reflect", "extract learnings", "self-improve", or after completing complex tasks.
---

# Reflect - Agent Self-Improvement Skill

Transform your AI assistant into a continuously improving partner. Every correction becomes a permanent improvement without bloating base prompts or causing cross-project pollution.

## Quick Reference

| Command / Trigger | Operating Scope | Target Destination |
| :--- | :--- | :--- |
| `reflect` | **Project (Local)** | Current project's `./AGENTS.md` |
| `reflect global` | **User (Global)** | Global persona in `~/.pi/agent/AGENTS.md` |
| `reflect review` | Review pending learnings or proposed rule diffs | Active targets |

---

## Target Scope Model

### 1. Project Rules (Default: Local `./AGENTS.md`)
- **When**: Triggered in chat (`reflect`) after completing a task or receiving a correction in any repository.
- **Scope**: **Strictly Local**. Targets `./AGENTS.md` in the current project root.
- **Purpose**: Captures domain rules, local ports, database settings, test fixtures, and repo conventions without polluting other projects.

### 2. User Persona Rules (Global `~/.pi/agent/AGENTS.md`)
- **When**: A correction is explicitly universal across all projects and languages (e.g. communication tone, git commit hygiene, safety verification gates).
- **Scope**: **User-Wide**. Targets `~/.pi/agent/AGENTS.md`.
- **Constraint**: Must remain lean and minimal. Never place project-specific or language-specific rules in the global persona.

### 3. Reusable Skills (Procedural Playbooks)
- **When**: A non-trivial debugging solution, workaround, or multi-step recipe is discovered.
- **Scope**: Scaffolds a new standalone skill in `.agents/skills/<name>/SKILL.md` or `skills/<name>/SKILL.md`.

---

## Workflow

### Step 1: Scan for Signals

Analyze the conversation for friction signals:

| Confidence | Triggers | Examples |
| :--- | :--- | :--- |
| **HIGH** | Explicit corrections & prohibitions | "never", "always", "wrong", "stop", "the rule is", "no, use..." |
| **MEDIUM** | Approved approaches & validations | "perfect", "exactly", "that's right", accepted implementation |
| **LOW** | Exploratory observations | Patterns that worked but were not explicitly validated |

See [signal_patterns.md](references/signal_patterns.md) for detailed detection patterns.

### Step 2: Classify & Match to Target Files

Map each signal to the appropriate destination based on scope:

| Scope | Category | Target File | Target Section |
| :--- | :--- | :--- | :--- |
| **Local** | Domain / Environment / Tooling | `./AGENTS.md` | `## Domain Rules` / `## Environment` |
| **Local** | Repo Testing / Conventions | `./AGENTS.md` | `## Testing Protocols` / `## Conventions` |
| **Global** | Universal Baseline (Tone / Hygiene) | `~/.pi/agent/AGENTS.md` | `## Communication Style` / `## Operational Rules` |
| **Procedural** | Reusable Multi-Step Solution | `.agents/skills/<name>/SKILL.md` | New standalone skill |

See [agent_mappings.md](references/agent_mappings.md) for full mapping rules.

### Step 3: Check for Skill-Worthy Signals

Decide whether a discovery should be a rule or a new standalone skill:

**Skill-Worthy Criteria:**
- Non-obvious debugging (>10 min investigation).
- Misleading error (root cause differs from symptom).
- Workaround discovered through trial and error.
- Reusable multi-step procedure.

**Quality Gates (must pass all):**
- [ ] Reusable: Helps with future tasks across projects.
- [ ] Non-trivial: Requires discovery, not just standard documentation.
- [ ] Specific: Clearly defines trigger conditions and steps.
- [ ] Verified: Solution actually worked.
- [ ] No duplication: Does not already exist in skills.

### Step 4: Generate Proposals (Human-in-the-Loop)

Present findings in a structured proposal with an exact unified diff:

```markdown
# Reflection Analysis

## Signals Detected
| # | Signal | Confidence | Source Quote | Category |
|---|---|---|---|---|
| 1 | Use uv run for pytest | HIGH | "Always use uv run with pytest" | Tooling / Local |

## Proposed Changes
### Target: `./AGENTS.md` (Local)
**Section**: `## Testing & QA`

```diff
## Testing & QA
+ * Always execute test runners and linters via `uv run` (e.g. `uv run pytest`, `uv run ruff check`).
```

Apply these changes? (Y/N/modify)
```

### Step 5: Apply with User Approval

- **On `Y` (approve)**: Apply change using file editing tools and confirm.
- **On `N` (reject)**: Discard proposed changes.
- **On `modify`**: Allow manual adjustment before applying.

---

## Safety Guardrails

1. **Human-in-the-Loop**: NEVER modify instruction files without explicit user confirmation.
2. **Additive Only**: Append or refine sections; never silently delete existing instructions.
3. **Lean Global Persona**: Keep `~/.pi/agent/AGENTS.md` minimal. Reject verbose or language-specific rules from global scope.
4. **Conflict Detection**: Check if the proposed rule contradicts existing directives before proposing.

---

## Examples

### Example 1: Local Project Rule
- **User says**: *"In this service, always run database migrations on port 5433."*
- **Target**: Local `./AGENTS.md` (`## Environment & Tooling`)
- **Addition**:
  ```diff
  + * Database migrations and local testing must use Postgres port 5433.
  ```

### Example 2: Universal Global Rule
- **User says**: *"Always run git status before creating a commit."*
- **Target**: Global `~/.pi/agent/AGENTS.md` (`## Commit Hygiene`)
- **Addition**:
  ```diff
  + * Follow Conventional Commits format with a concise summary subject line (<72 chars).
  ```

### Example 3: Reusable Skill Creation
- **Context**: 45 minutes spent resolving a subtle SQLite lock contention under async workers.
- **Target**: `.agents/skills/sqlite-wal-concurrency/SKILL.md` (or `skills/`)
