# pi-repl (pi extension)

Python eval and inspection against the project's **uv** environment. Stateless:
every call shells out to `uv run`, which resolves the project environment from
`pyproject.toml`/`uv.lock` in the working directory.

## Tools

| Tool | Behavior |
|---|---|
| `py_eval` | Run a Python snippet (`uv run python -c`) and return compact stdout/stderr/exit code |
| `py_inspect` | Inspect a dotted path (`pkg.module.func`) → signature, first docstring line, type hints, source location |

## Why uv

`uv run` auto-resolves the project environment, so the tools inspect and execute
against the project's actual interpreter and dependency versions — not whatever
`python` happens to resolve first on PATH. No venv activation needed.

## Self-gating

Both tools check for `pyproject.toml` in the working directory. Outside a uv
project they return a clean "not a uv project" message instead of failing.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/index.ts" ~/.pi/agent/extensions/pi-repl.ts
# or install the directory as a pi package:
pi install /absolute/path/to/pi-extensions/pi-repl
```

Then run `/reload` in pi.

## Caveats

- `python -c` requires top-level code (no leading indentation). Snippets must
  start at column 0; this matches typical agent one-liners and experiments.
- First `uv run` in a session has cold-start latency while uv resolves the
  environment; later calls are fast.
- `py_inspect` returns the first non-empty docstring line, type hints, and
  `file:line`; it does not dump full source.
