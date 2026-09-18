# Python Development with Pi Agent

A complete overview of the Python development toolchain, extensions, flavors, and QA automation available in this repository.

---

## 🧭 Architecture & Mental Model

The Python development environment for Pi is built on four core principles:
1. **`uv`-First Package & Environment Management**: Zero manual virtualenv activation, zero `pip install`, reproducible `uv.lock`.
2. **Native Rust Speed**: Fast linting, formatting, and type-checking via `ruff` and `ty`.
3. **Token-Defensive Execution**: All test outputs, linters, and inspections are strictly line-capped and filtered to failure-only reports to preserve the LLM's context window.
4. **Editor & Runtime Awareness**: Deep integration with Neovim via RPC and stateless REPL introspection.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        PYTHON TOOLING FOR PI                           │
├────────────────────────────────────────────────────────────────────────┤
│ 1. SESSION FLAVOR (flavors/python.md)                                  │
│    • PEP 695 typing, Google docstrings, src/ layout, hatchling backend  │
├────────────────────────────────────────────────────────────────────────┤
│ 2. QA GATES & AUTOMATION (templates/justfiles/python-uv.just)          │
│    • `just test`, `just lint`, `just fix`, `just typecheck`, `check`   │
├────────────────────────────────────────────────────────────────────────┤
│ 3. REPL & INTROSPECTION (pi-extensions/pi-repl)                        │
│    • `py_eval`    : Dynamic snippet execution in project's uv env      │
│    • `py_inspect` : Signature, type hint, & docstring lookup           │
├────────────────────────────────────────────────────────────────────────┤
│ 4. CODE INTELLIGENCE & LSP (pi-extensions/neovim & lsp-bridge)         │
│    • Neovim RPC   : Live editor diagnostics (ruff + ty), cursor context│
│    • Subagent     : `py-explore` for deep dependency & call graph maps │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Launching Pi with the Python Flavor

Use `just pi python` (or the global `pih` helper) to overlay Python-specific engineering standards onto the base persona:

```bash
# Inside repo
just pi python
just pi rapid python      # compose MVP prototyping + Python rules
just pi plan python       # compose read-only planning + Python rules

# From anywhere (via bashrc `pih` alias)
pih python
pih rapid python "implement user authentication service"
```

### What the Python flavor enforces ([`flavors/python.md`](../flavors/python.md)):
- **Python 3.13+** with modern typing syntax (`list[str]`, `dict[str, int]`, `X | None` instead of `typing.Optional`/`Union`).
- **`src/<package>/` layout** with domain logic isolated in `core/`.
- **Strict Exception Handling**: Specific exceptions only, logging before re-raising, no bare `except`.
- **Security Guardrails**: Safe deserialization (`yaml.safe_load`), parameterized SQL queries, no `eval`/`exec`.

---

## 2. Token-Defensive QA Gates (`python-uv.just`)

When scaffolding Python projects via `just setup-python <target>`, the project receives a token-optimized [`justfile.agent`](../templates/justfiles/python-uv.just):

| Recipe | Command | Context-Saving Strategy |
| :--- | :--- | :--- |
| `just test [filter]` | `uv run pytest -q --tb=short ...` | Suppresses headers and passing tests; pipes only failures and summary (capped at 40 lines). |
| `just lint` | `uv run ruff check . --output-format=concise` | Concise one-line-per-violation output (capped at 30 lines). |
| `just fix` | `uv run ruff check --fix && uv run ruff format` | Applies safe fixes and formatting quietly without spamming stdout. |
| `just typecheck` | `ty check` (or `uv run ty check`) | Native Rust type checks via Astral's `ty` (capped at 30 lines). |
| `just check` | `lint` + `typecheck` + `test` | **Single-turn QA gate**: Runs all checks in sequence before committing. |

---

## 3. Dynamic REPL & Introspection ([`pi-repl`](../pi-extensions/pi-repl/README.md))

Pi includes native tools for inspecting and executing Python code against the project's actual `uv` environment:

### `py_eval` (Stateless Execution)
Executes dynamic Python snippets inside the project's virtualenv without manual setup:
```python
# Example agent tool call
py_eval(code="import httpx; client = httpx.Client(); print(client.get('https://httpbin.org/get').status_code)")
```
- Automatically resolves the interpreter from `pyproject.toml` / `uv.lock`.
- Returns stdout, stderr, and exit code.

### `py_inspect` (Runtime Metadata & Signatures)
Introspects Python modules, classes, and functions via dotted path without reading full source files:
```python
# Example agent tool call
py_inspect(target="fastapi.APIRouter")
# Output: class APIRouter(prefix="", tags=None, ...) | [fastapi/routing.py:45]
```
- Extracts function signatures, parameter defaults, and type annotations.
- Returns the first non-empty docstring line and exact `file:line` definition.

---

## 4. Code Navigation & LSP Ecosystem

```text
Interactive Session (Neovim)          Deep Investigation (Standalone)
────────────────────────────          ───────────────────────────────
• ruff (lint/format)                  • py_inspect (fast signature lookup)
• ty (instant type checking)          • py-explore subagent (asynchronous)
• vim.lsp via MessagePack RPC         • uv run --with pyright (ephemeral)
```

1. **Inside Neovim**:
   - `pi-extension-neovim` queries Neovim's active LSP clients (`ruff` + `ty`) via RPC.
   - Provides live cursor context, buffer sync on edits, and diagnostic extraction.
2. **Deep Research & Refactoring (`py-explore` Subagent)**:
   - For complex architecture reviews or cross-module call graph tracing, Pi spawns an isolated `py-explore` subagent.
   - The subagent can run `uv run --with pyright` on demand to build full type and dependency graphs without polluting `pyproject.toml`.

---

## 5. Quick Workflow Recipes

### Scaffolding a new project
```bash
just setup-python ~/DEV/my-new-service
```
Copies `justfile.agent` and standard `AGENTS.md` rules into the target directory.

### Running a full session
```bash
cd ~/DEV/my-new-service
pih python "Add caching layer to user repository"
```
During the session, Pi will:
1. Inspect existing signatures with `py_inspect`.
2. Test code snippets with `py_eval`.
3. Apply changes and sync buffers with Neovim.
4. Run `just check` to verify formatting, types, and tests in a single token-efficient turn.
