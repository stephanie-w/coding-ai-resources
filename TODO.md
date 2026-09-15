# Project TODO

## Extensions Implementation Backlog

### Extension: `notify-i3` (Desktop & Window Manager Alerts)
- [ ] Create extension directory `pi-extensions/notify-i3/`
- [ ] Implement `package.json` with Pi extension manifest
- [ ] Implement `index.ts` sending `notify-send` on two triggers: `agent_settled` (task finished) and `ui_prompt_start` (blocked on user prompt); subagent notifications dropped (no event, noisy)
- [ ] Add configurable duration threshold (only notify task-finished for tasks >5s; prompt-wait notifies immediately)
- [ ] Add `/notify` slash command (toggle, test notification, threshold config, status)
- [ ] Add `README.md` documentation

### Extension: `context-monitor` (Token & Context Budget Indicator)
- [x] Create extension directory `pi-extensions/context-monitor/`
- [x] Implement `package.json` with Pi extension manifest
- [x] Implement `index.ts` tracking input/output tokens and context window fill percentage
- [x] Render color-coded status bar badge (e.g. `[ctx: 32k/128k (25%)]`) in Pi TUI
- [x] Add `/tokens` slash command to display session token breakdown (exact totals + estimated composition; renamed from `/context` to avoid collision with `pi-context-inspector`)
- [x] Add `README.md` documentation

### Extension: `pi-repl` (Python REPL / `.venv` Inspector)
- [x] Evaluate approach: lightweight `uv` inspector tool (chosen over `pi-repl-py` kernel wrapper)
- [x] Create extension directory `pi-extensions/pi-repl/`
- [x] Implement `package.json` with Pi extension manifest
- [x] Implement `index.ts` registering dedicated `py_eval` / `py_inspect` tool
- [x] Automatically bind execution to project's active `.venv` / `uv` environment (via `uv run`; self-gates on `pyproject.toml`)
- [x] Format docstrings, object inspection, and signatures compactly for the model
- [x] Add `README.md` documentation

### Extension: `subagents` (Generic Declarative Subagent Factory)

- **Concept**: A generic subagent orchestrator and factory that separates behavioral definitions (declarative Markdown files with YAML frontmatter) from execution runtime (TypeScript extension). Allows users and projects to define custom, specialized subagents simply by dropping `.md` files into designated subagent folders.

- **Discovery Hierarchy**:
  - Global definitions: `~/.pi/agent/subagents/*.md`
  - Project definitions: `.pi/subagents/*.md` (and git root ancestor directories)
  - Catalog/Package definitions: `subagents/*.md`

- **Subagent Definition Specification (`<name>.md`)**:
  - **YAML Frontmatter Fields**:
    - `name` (*string*, required): Unique tool identifier exposed to the orchestrator model (e.g. `explore`, `reviewer`).
    - `description` (*string*, required): Tool description for the parent LLM.
    - `tools` (*string[]*, optional): Tool whitelist for the subagent (e.g. `["read", "grep", "find"]`). Prevents side-effects.
    - `model` (*string*, optional): Dedicated model alias/ID (e.g. `openai/gpt-4o-mini`, `deepseek/deepseek-v4-flash`, `anthropic/claude-3-5-haiku`).
    - `thinking` (*integer 0–3*, optional): Thinking level override for the subagent.
    - `guidelines` (*string[]*, optional): Guidelines injected directly into the LLM system prompt via `promptGuidelines` in `registerTool()`.
  - **Body Content**: Appended system prompt instructions defining the subagent's persona, constraints, output format, and domain rules.

- **Runtime & Execution Mechanics (`index.ts`)**:
  - Scan directories on startup / session start and parse frontmatter metadata.
  - Dynamically register each valid definition as a distinct tool via `pi.registerTool()`.
  - On tool invocation:
    - Increment and inject `PI_SUBAGENT_DEPTH` (`depth = current_depth + 1`) into child environment.
    - Spawn headless child session via `pi.exec("pi", ["-p", "--append-system-prompt", <file>, ...], { signal, cwd })`.
    - Apply `--tools`, `--model`, and `--thinking` CLI arguments according to definition frontmatter.
    - Stream live progress updates via `onUpdate` to the main TUI.
    - Handle abort signals (`signal`) and propagate termination to child process.
    - Return clean, trimmed stdout text or actionable error messages.
  - Guardrail alignment: Ensure compatibility with `bash-guard` headless hard-blocking for `PI_SUBAGENT_DEPTH >= 1`.

- **Backlog & Implementation Tasks**:
  - [ ] Create extension directory `pi-extensions/subagents/`
  - [ ] Implement `package.json` with Pi extension manifest
  - [ ] Implement `index.ts` with directory discovery, frontmatter parser, and dynamic `pi.registerTool()` registration
  - [ ] Implement robust child process execution with `PI_SUBAGENT_DEPTH` injection and cancellation handling
  - [ ] Create bundled default subagent definitions:
    - [ ] `subagents/explore.md` (read-only searcher with `read,grep,find` and fast flash model)
    - [ ] `subagents/reviewer.md` (diff / patch reviewer with `read,grep,bash`)
  - [ ] Add `/subagents` slash command (list loaded subagents, paths, active models, and tool whitelists)
  - [ ] Add `README.md` documentation and authoring guide for custom subagent `.md` files
