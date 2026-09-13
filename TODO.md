# Project TODO

## Extensions Implementation Backlog

### Extension: `notify-i3` (Desktop & Window Manager Alerts)
- [ ] Create extension directory `pi-extensions/notify-i3/`
- [ ] Implement `package.json` with Pi extension manifest
- [ ] Implement `index.ts` hooking into Pi events (`agent_end`, `subagent_end`, tool prompts) to trigger `notify-send`
- [ ] Add configurable duration threshold (only notify for tasks >5s)
- [ ] Add `/notify` slash command (toggle, test notification, threshold config)
- [ ] Add `README.md` documentation

### Extension: `context-monitor` (Token & Context Budget Indicator)
- [x] Create extension directory `pi-extensions/context-monitor/`
- [x] Implement `package.json` with Pi extension manifest
- [x] Implement `index.ts` tracking input/output tokens and context window fill percentage
- [x] Render color-coded status bar badge (e.g. `[ctx: 32k/128k (25%)]`) in Pi TUI
- [x] Add `/tokens` slash command to display session token breakdown (exact totals + estimated composition; renamed from `/context` to avoid collision with `pi-context-inspector`)
- [x] Add `README.md` documentation
- [ ] R4: compaction threshold marker + headroom projection
- [ ] R5: per-model context-window switch warning

### Extension: `pi-repl` (Python REPL / `.venv` Inspector)
- [x] Evaluate approach: lightweight `uv` inspector tool (chosen over `pi-repl-py` kernel wrapper)
- [x] Create extension directory `pi-extensions/pi-repl/`
- [x] Implement `package.json` with Pi extension manifest
- [x] Implement `index.ts` registering dedicated `py_eval` / `py_inspect` tool
- [x] Automatically bind execution to project's active `.venv` / `uv` environment (via `uv run`; self-gates on `pyproject.toml`)
- [x] Format docstrings, object inspection, and signatures compactly for the model
- [x] Add `README.md` documentation
