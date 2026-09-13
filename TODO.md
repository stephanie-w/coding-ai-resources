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
- [ ] Create extension directory `pi-extensions/context-monitor/`
- [ ] Implement `package.json` with Pi extension manifest
- [ ] Implement `index.ts` tracking input/output tokens and context window fill percentage
- [ ] Render color-coded status bar badge (e.g. `[ctx: 32k/128k (25%)]`) in Pi TUI
- [ ] Add `/context` or `/tokens` slash command to display session token breakdown
- [ ] Add `README.md` documentation

### Extension: `pi-repl` (Python REPL / `.venv` Inspector)
- [ ] Evaluate approach: lightweight `uv` inspector tool vs `pi-repl-py` kernel wrapper
- [ ] Create extension directory `pi-extensions/pi-repl/`
- [ ] Implement `package.json` with Pi extension manifest
- [ ] Implement `index.ts` registering dedicated `py_eval` / `py_inspect` tool
- [ ] Automatically bind execution to project's active `.venv` / `uv` environment
- [ ] Format docstrings, object inspection, and signatures compactly for the model
- [ ] Add `README.md` documentation
