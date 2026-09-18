# Project TODO

## Security & Sandbox Backlog

### Issue: Unrestricted read access to sensitive files & environment (HIGH)
- **Problem**: `read`, `grep`, `find`, `ls`, `bash`, and `env` have unrestricted access to shell config (`.bashrc`, `.zshrc`, `.profile`), `.env*`, `~/.ssh/`, `~/.aws/`, `~/.kube/`, `~/.netrc`, `~/.git-credentials`, and the process environment (API keys). No guardrail intercepts these reads.
- **Confirmed**: 2026-09-18 — agent grepped shell configs and read `env` with no interception. `bash-guard` covers destructive bash only; `gondolin` (filesystem isolation) was disabled.
- [x] Implement `secrets-guard` extension (`pi-extensions/secrets-guard/`): block or prompt on sensitive reads
  - [x] Intercept `read`, `grep`, `find`, `ls`, `bash`, `env` calls touching sensitive paths
  - [x] Default sensitive-path list (shell rc, dotfiles, credentials, SSH/cloud keys)
  - [x] Workspace Jailing (block/prompt any access outside `process.cwd()` except `/tmp`)
  - [x] Interactive confirm in main session; hard-block in subagents (`PI_SUBAGENT_DEPTH >= 1`)
  - [x] Block raw `env` and credential-dumping commands by default
  - [x] Allowlist / toggle command (`/secrets-guard`) and start flags
- [x] Subagent Process & Safety Visibility:
  - [x] Track and display subagent OS `PID` across single, chain, and parallel task renders
  - [x] Real-time live status updates with `SIGTERM`/`SIGKILL` on cancellation (`Ctrl+C`)

### Issue: Gondolin posture & subagents-in-sandbox
- **Context**: Gondolin currently disabled via `GONDOLIN_DISABLED=1`; earlier plan was to make it opt-in for strict-isolation tasks.
- [x] Resolve subagents inside gondolin: auto-bypass `VM.create()` when `PI_SUBAGENT_DEPTH >= 1` is detected so subagents execute without nested VM crashes.
- [ ] Add `just gondolin` recipe + shell alias (`pihg`) for explicit strict sessions
- [ ] Document the chosen posture in README and `docs/pi-harness.md`

## Extensions Implementation Backlog

### Extension: `notify-i3` (Desktop & Window Manager Alerts)
- **Reference Base**: Upstream [`docs/pi-agent/examples/extensions/notify.ts`](docs/pi-agent/examples/extensions/notify.ts).
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

### Extension: `subagents` (Generic Declarative Subagent Orchestrator & Factory)

- **Foundation & Upstream Base**:
  - Based on and adapted from upstream reference implementation in [`docs/pi-agent/examples/extensions/subagent/`](docs/pi-agent/examples/extensions/subagent/) (`agents.ts` + `index.ts`), originally from [`earendil-works/pi`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent).

  - Separates **declarative authoring** (simple `.md` files with YAML frontmatter for 90% of specialized agents) from **programmatic authoring** (custom TypeScript extensions for complex runtime logic or UI loops).

- **Discovery Hierarchy**:
  - Global definitions: `~/.pi/agent/agents/*.md` and `~/.pi/agent/subagents/*.md`
  - Project definitions: `.pi/agents/*.md` and `.pi/subagents/*.md` (and git root ancestor directories)
  - Catalog/Package definitions: `agents/*.md` and `subagents/*.md`

- **Subagent Definition Specification (`<name>.md`)**:
  - **YAML Frontmatter Fields**:
    - `name` (*string*, required): Unique tool identifier exposed to the orchestrator model (e.g. `explore`, `reviewer`, `py-explore`).
    - `description` (*string*, required): Tool description for the parent LLM.
    - `tools` (*string[] | string*, optional): Tool whitelist for the child subagent (e.g. `["read", "grep", "find"]` or `read, grep, find`). Prevents side-effects.
    - `model` (*string*, optional): Dedicated model alias/ID (e.g. `openai/gpt-4o-mini`, `deepseek/deepseek-v4-flash`, `anthropic/claude-3-5-haiku`).
    - `thinking` (*integer 0–3*, optional): Thinking level override for the subagent.
    - `direct_tool` (*boolean*, optional, default `false`): When `true`, also registers a direct top-level tool (e.g. `explore(task: string)`) in addition to the unified `subagent` tool.
    - `guidelines` (*string[]*, optional): Guidelines injected directly into LLM system prompt via `promptGuidelines` in `registerTool()`.
  - **Body Content**: Appended system prompt instructions defining the subagent's persona, constraints, output format, and domain rules.

- **Tool Interface & Modes (Hybrid Model)**:
  1. **Unified Meta-Tool (`subagent`)**: Registered by default to handle multi-agent orchestration:
     - `single`: `{ agent: "name", task: "..." }`
     - `parallel`: `{ tasks: [{ agent: "name", task: "..." }, ...] }` (concurrent execution up to `MAX_CONCURRENCY = 4`)
     - `chain`: `{ chain: [{ agent: "name", task: "... {previous} ..." }, ...] }` (pipelined handoffs)
  2. **Direct Dedicated Tools (Optional / Dynamic)**:
     - Automatically registers high-frequency agents or agents with `direct_tool: true` as dedicated tools (e.g. `explore(task)`, `py_explore(task)`) for ergonomic single-turn tool calls.

- **Runtime & Execution Mechanics (`index.ts` & `agents.ts`)**:
  - **Runtime Resolution**: Use upstream `getPiInvocation()` to transparently resolve running Pi binary across standalone binary, Bun, or Node environments.
  - **Headless Structured Execution**: Spawn child process with `--mode json` to stream turn-by-turn assistant messages, tool calls, token usage (input, output, cache read/write), costs, and turns.
  - **Live TUI Widget Rendering**: Render rich, collapsable execution updates using Pi's native UI components (`@earendil-works/pi-tui`: `Container`, `Markdown`, `Text`, `Spacer`).
  - **Depth & Guardrail Propagation**: Inject `PI_SUBAGENT_DEPTH = currentDepth + 1` into child `env` to coordinate with `bash-guard` headless hard-blocking for `PI_SUBAGENT_DEPTH >= 1`.
  - **Resource Safeguards**: Apply `mapWithConcurrencyLimit` for parallel jobs, enforce `PER_TASK_OUTPUT_CAP = 50KB` to protect parent context window, and propagate `signal` abort events to kill child process trees.

- **Backlog & Implementation Tasks**:
  - [x] Create extension directory `pi-extensions/subagents/` with `package.json` manifest
  - [x] Port & adapt upstream `agents.ts` (multi-directory discovery, defensive YAML frontmatter parsing)
  - [x] Implement `index.ts` with `--mode json` streaming, `@earendil-works/pi-tui` live rendering, `PI_SUBAGENT_DEPTH` injection, and abort handling
  - [x] Implement hybrid tool registration (unified `subagent` tool + optional `direct_tool` shortcuts)
  - [ ] Create bundled default subagent definitions:
    - [x] `subagents/explore.md` (`direct_tool: true`, fast polyglot read-only code searcher with `read,grep,find` and flash model)
    - [x] `subagents/py-explore.md` (`direct_tool: true`, Python structural & dependency investigator using `read,grep,find,py_inspect` and ephemeral `uv run --with pyright`)
    - [x] `subagents/reviewer.md` (`direct_tool: true`, diff / code reviewer with `read,grep,find,py_inspect` and flash model with `thinking: 2`)
  - [x] Add `/subagents` slash command (list loaded subagents, discovery paths, active models, tool whitelists, and registration mode)
  - [x] Add `README.md` documentation and authoring guide for custom subagent `.md` files


### Extension: `lsp-bridge` (Unified Language Server Protocol & Code Intelligence)

- **Concept**: A unified code intelligence and semantic navigation extension providing deep LSP capabilities (go-to-definition, find references, symbol outlines, call hierarchies, hover docstrings, and live diagnostics). Employs a dual-backend router that dynamically selects the optimal transport based on runtime environment:
  1. **Editor-Attached Mode (`$NVIM` set)**: Routes requests via MessagePack-RPC to the parent Neovim session's active `vim.lsp` client. Shares warm project indices, unsaved buffer states, and custom user editor configurations with zero extra memory or startup overhead.
  2. **Standalone Headless Mode (`$NVIM` unset)**: Spawns and manages headless language servers over JSON-RPC (stdio) on-demand for CLI, tmux, and subagent sessions.

- **Unified Tool Contract**:
  - `lsp_definition`: Jump directly to symbol definitions or declarations across workspace files and third-party dependencies.
  - `lsp_references`: Find all references, usages, and call sites across the project (crucial for safe refactoring).
  - `lsp_symbols`: Retrieve structural symbol outlines (classes, functions, methods) for a file or search symbols across the workspace.
  - `lsp_call_hierarchy`: Inspect incoming (callers) and outgoing (callees) function call graphs.
  - `lsp_hover`: Inspect exact type signatures, inferred types, and docstrings for a symbol.
  - `lsp_diagnostics`: Query live compiler/linter diagnostics for a line or entire buffer.

- **Dual-Backend Architecture & Mechanics**:

  ```text
  ┌─────────────────────────────────────────────────────────────┐
  │                      Pi Agent (LLM)                         │
  │   Tools: lsp_definition, lsp_references, lsp_symbols, ...   │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                  Is $NVIM socket present?
                 /                        \
          [ YES ]                          [ NO ]
             ▼                                ▼
  ┌───────────────────────────┐    ┌───────────────────────────┐
  │     Neovim RPC Client     │    │   Standalone LSP Client   │
  │ • vim.lsp.buf_request_sync│    │ • On-demand JSON-RPC stdio│
  │ • Zero extra RAM / 0ms    │    │ • Auto-detects runtime    │
  │ • Unsaved buffer aware    │    │ • Lazy server startup     │
  │ • Uses user's LSP config  │    │ • Hook-driven buffer sync │
  └───────────────────────────┘    └───────────────────────────┘
  ```

  - **Neovim Backend (`vim.lsp` RPC bridge)**:
    - Executed via `nvim_exec_lua` / MessagePack-RPC.
    - Synchronously calls `vim.lsp.buf_request_sync` for standard LSP methods (`textDocument/definition`, `textDocument/references`, `textDocument/documentSymbol`, `textDocument/hover`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls`).
    - Formats locations, ranges, and symbols into compact, token-efficient Markdown strings.

  - **Standalone Headless Backend (JSON-RPC stdio worker)**:
    - **Discovery & Spawning**: Auto-detects project markers (`pyproject.toml`, `package.json`, `Cargo.toml`, `go.mod`) and locates the appropriate language server binary:
      - Python: Native lightweight servers (`ty`, `ruff server`) prioritized; `uv run pyright-langserver` or `.venv/bin/pyright-langserver` used as an on-demand fallback when deep cross-module type graphs are required.
      - TypeScript/JavaScript: `npx @vtsls/language-server --stdio` or `npx typescript-language-server --stdio`.
      - Rust: `rust-analyzer`.
      - Go: `gopls`.
    - **Capability-Aware Degradation**: Handles language servers with partial LSP implementations (e.g. `ruff` for fast diagnostics/formatting; `ty` for type checking) by checking server capabilities on initialization and returning clear, actionable feedback if an unsupported method (like call hierarchy) is invoked.
    - **Lazy Initialization**: Server processes are spawned in the background only when the first LSP tool is invoked (zero startup penalty for standard Pi CLI usage).
    - **Buffer Synchronization**: Listens to Pi's `tool_result` events (`write`, `edit`) to emit `textDocument/didChange` or `textDocument/didSave` notifications, keeping the language server's in-memory AST synchronized without full restarts.
    - **Lifecycle**: Automatically shuts down child LSP processes on session exit.

- **Backlog & Implementation Tasks**:
  - [ ] **Phase 1: Neovim LSP Navigation Extensions**
    - [ ] Implement `nvim_lsp_definition` in `pi-extensions/neovim/`
    - [ ] Implement `nvim_lsp_references` in `pi-extensions/neovim/`
    - [ ] Implement `nvim_lsp_symbols` (document and workspace symbols) in `pi-extensions/neovim/`
    - [ ] Implement `nvim_lsp_call_hierarchy` (incoming/outgoing calls) in `pi-extensions/neovim/`
    - [ ] Implement `nvim_lsp_hover` (type signature & docstrings) in `pi-extensions/neovim/`
    - [ ] Add Lua helper scripts in `neovim.ts` for clean formatting and token-efficient responses
  - [ ] **Phase 2: Standalone Headless LSP Client**
    - [ ] Create extension directory `pi-extensions/lsp/` with `package.json` manifest
    - [ ] Implement minimal JSON-RPC client over stdio in `index.ts`
    - [ ] Implement language server discovery logic (Python/`uv`, Node/`npx`, Rust/`cargo`, Go)
    - [ ] Implement lazy process spawning, `initialize` handshake, and graceful teardown
    - [ ] Implement buffer sync via `tool_result` event hooks (`didOpen`, `didChange`, `didSave`)
  - [ ] **Phase 3: Unified Router & Tool Aliasing**
    - [ ] Unify tool registration so LLM accesses `lsp_*` seamlessly across both environments
    - [ ] Add `/lsp` slash command (display active backend, connected servers, root URI, status)
    - [ ] Add `README.md` documentation and setup guides

