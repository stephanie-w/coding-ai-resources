---
description: "Rules for Python development: uv environment management, justfile QA gates, and pytest verification."
applyTo: "**/*.py, **/pyproject.toml, **/justfile*"
---

# Python Development Guidelines

Rules for Python environments, tool execution, and verification workflows.

---

## 1. Environment & Package Management (`uv`)

1. **Always use `uv run`**: Execute all Python scripts, tests, and CLI tools via `uv run` (e.g. `uv run pytest`, `uv run ruff check`, `uv run mypy`). Never activate virtualenvs manually (`source .venv/bin/activate`) or call bare `python`.
2. **Dependency Management**: Add packages via `uv add <package>` and dev dependencies via `uv add --dev <package>`. Never manually edit `pyproject.toml` dependency arrays or run bare `pip install`.
3. **Lockfile Discipline**: Keep `uv.lock` in sync. Never manually modify `uv.lock`.

---

## 2. Agent QA Gates & Inspection (`justfile.agent`)

If `justfile.agent` (or a project `justfile`) exists in the workspace root, prioritize running standard agent recipes:

- **Single-Turn QA Gate:** `just -f justfile.agent check` (runs lint + typecheck + test in one shot).
- **Test Execution:** `just -f justfile.agent test [filter]` (returns only test failures, zero clutter on success).
- **Code Lint & Format:** `just -f justfile.agent lint` and `just -f justfile.agent fix`.
- **Fast Code Inspection:** `just -f justfile.agent search <pattern>`, `just -f justfile.agent find-files <pattern>`, and `just -f justfile.agent view <file> <start> <end>`.
- **Git Context:** `just -f justfile.agent git-summary` and `just -f justfile.agent git-diff`.

---

## 3. Testing Standards (`pytest`)

1. **Failure-Focused Output:** Run tests with `-q --tb=short` or via `just test` to keep context clean.
2. **Targeted Verification:** Test specific files or functions (`uv run pytest tests/test_module.py -k test_target`) rather than running entire suites on every small edit.
3. **Purity in Tests:** Fixtures should be scoped tightly. Mock external HTTP and database boundaries cleanly.
