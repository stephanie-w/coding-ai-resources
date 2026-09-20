# pi-subagents

Declarative subagent factory for Pi. Drop a `.md` file with YAML frontmatter
into a discovery directory and it becomes a tool the main agent can call. Each
invocation spawns a fresh headless `pi` process, so the subagent gets its own
isolated context window, model, and tool whitelist.

## Features

- **Declarative authoring** — a subagent is just `<name>.md` (frontmatter + body).
- **Hybrid interface** — a unified `subagent` meta-tool (single / parallel /
  chain) plus dedicated top-level tools for agents with `direct_tool: true`.
- **Live streaming** — child runs in `--mode json`; tool calls, text, and usage
  render in the parent TUI (collapsed + `Ctrl+O` expanded).
- **Depth-aware guardrails** — injects `PI_SUBAGENT_DEPTH = depth + 1` so
  `bash-guard` hard-blocks catastrophic commands in headless subagents.
- **Resource safeguards** — parallel jobs capped at 4 concurrent, 8 total;
  per-task output capped at 50 KB in the model-visible result; abort (`Esc`)
  kills the child process tree.

## Discovery hierarchy

Directories are scanned in this precedence order (highest wins on name
collisions):

| Level | Paths | Source |
| :--- | :--- | :--- |
| Catalog (bundled) | `<extension>/agents/*.md`, `<extension>/subagents/*.md` | `catalog` |
| Global | `~/.pi/agent/agents/*.md`, `~/.pi/agent/subagents/*.md` | `user` |
| Project | `.pi/agents/*.md`, `.pi/subagents/*.md` (and all ancestor dirs) | `project` |

Catalog agents always load. The `subagent` tool's `agentScope` toggles user vs
project: default `"user"` (catalog + user), `"both"` adds project agents,
`"project"` restricts to catalog + project.

Project agents are repo-controlled, so they are gated: interactive sessions
prompt before running them in an untrusted project; direct tools only register
project agents when the project is trusted.

## Definition format

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find          # or: [read, grep, find]; omit for all defaults
model: anthropic/claude-3-5-haiku  # optional; omit to inherit parent model
thinking: 2                       # optional; 0=off, 1=low, 2=medium, 3=high
direct_tool: true                 # optional; also register `my_agent(task)` directly
guidelines:                       # optional; injected as the direct tool's guidelines
  - Use my_agent when ...
---

System prompt (persona, constraints, output format) goes here.
```

Fields:

| Field | Required | Notes |
| :--- | :--- | :--- |
| `name` | yes | Unique tool id, e.g. `explore`, `reviewer`, `py-explore`. |
| `description` | yes | Description shown to the parent LLM. |
| `tools` | no | Tool whitelist (string or array). Prevents side effects. |
| `model` | no | Model alias/ID. Omit to inherit the dispatching session's model. |
| `thinking` | no | Integer 0-3 override (0=off, 1=low, 2=medium, 3=high). |
| `direct_tool` | no | Default `false`. When `true`, also registers a dedicated tool. |
| `guidelines` | no | String array; appended to the direct tool's prompt guidelines. |

Body text becomes the child's appended system prompt (written to a temp file and
passed via `--append-system-prompt`).

`direct_tool: true` tool names are sanitized to valid identifiers:
`py-explore` → `py_explore`. Use unique agent names to avoid tool collisions.

## Tool interface

### Unified `subagent` tool

| Mode | Parameters |
| :--- | :--- |
| Single | `{ agent, task }` |
| Parallel | `{ tasks: [{ agent, task }, ...] }` (max 8, 4 concurrent) |
| Chain | `{ chain: [{ agent, task: "... {previous} ..." }, ...] }` |

Optional params: `agentScope` (`user` \| `project` \| `both`), `cwd`,
`confirmProjectAgents`.

### Direct tools

`direct_tool: true` agents get their own tool, e.g. `py_explore({ task, cwd? })`, `explore({ task, cwd? })`, or `git_commit({ task, cwd? })`.

## Bundled Catalog Subagents

The extension ships with the following pre-configured, high-velocity subagents:

| Agent / Tool | Model | Thinking | Tools Whitelist | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **`scout`** (`scout`) | `deepseek/deepseek-v4-flash` | `1` (Low) | `read, grep, find, py_inspect, bash` | Fast codebase recon & structured handoff briefs |
| **`py-explore`** (`py_explore`) | `deepseek/deepseek-v4-flash` | `0` (Off) | `read, grep, find, py_inspect, bash` | Fast Python structural investigator |
| **`explore`** (`explore`) | `deepseek/deepseek-v4-flash` | `0` (Off) | `read, grep, find` | Fast polyglot symbol and code locator |
| **`oracle`** (`oracle`) | `deepseek/deepseek-v4-flash` | `2` (Reasoning) | `read, grep, find, bash` | Second-opinion advisor, assumption challenger & lateral solver |
| **`worker`** (`worker`) | `deepseek/deepseek-v4-flash` | `2` (Reasoning) | `read, grep, find, edit, write, bash` | Surgical implementation writer bounded by the Laziness Protocol |
| **`reviewer`** (`reviewer`) | `deepseek/deepseek-v4-flash` | `2` (Reasoning) | `read, grep, find, py_inspect` | Critical code review, boundary analysis & regression checks |
| **`git-commit`** (`git_commit`) | `deepseek/deepseek-v4-flash` | `0` (Off) | `read, grep, find, bash` | Change clustering and Conventional Commits |

## Commands

- `/subagents` — list discovered agents, their source, model, tools, thinking
  level, and how each is exposed.

## Install

```bash
just link-extensions subagents
# or symlink manually:
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)/pi-extensions/subagents" ~/.pi/agent/extensions/subagents
```

Then run `/reload` in pi.

## Test it

1. **Load check** (no model or API key needed):
   ```bash
   pi -e ./pi-extensions/subagents/index.ts --list-models 2>&1 | grep -i "failed to load"
   ```
   Expect no output: the extension loads cleanly and registers the `subagent`
   tool, the `py_explore` direct tool, and the `/subagents` command.

2. **Live run** (requires a configured model):
   ```
   Use py_explore to map the imports and key classes in src/.
   ```
   Or the unified tool:
   ```
   subagent with agent=py-explore, task="trace the dependency graph".
   ```

3. **List agents** — run `/subagents` in an interactive session.

## Security model

- Subagents run with a tool whitelist from frontmatter; omit `tools` for full
  defaults, or specify a read-only set to prevent side effects.
- `PI_SUBAGENT_DEPTH >= 1` in child processes puts `bash-guard` into headless
  hard-block mode, so catastrophic commands are refused even when a subagent
  has `bash`.
- Project-local agents are trusted-repo-gated (see Discovery hierarchy).

## Limitations

- Parallel mode: max 8 tasks, 4 concurrent; model-visible output capped at
  50 KB per task (full output stays in tool details).
- Collapsed TUI view shows the last 10 items; `Ctrl+O` expands.
- Agents are re-discovered on every invocation, so edits to `.md` files apply
  mid-session without `/reload` (except for new `direct_tool` registrations,
  which happen at session start).
