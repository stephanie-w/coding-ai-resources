# Flavor: Python

Python engineering standards for this session: `uv`, `src` layout, quality gates,
and security.

## Toolchain

- **Python 3.13+**; use modern syntax (e.g. PEP 695 type parameters).
- **`uv` is the only package/environment manager.** `uv.lock` is the source of
  truth for reproducible builds.
  - `uv add <pkg>`, `uv add --dev <pkg>`, `uv sync`, `uv run <cmd>`.
  - Never `pip install`, never activate a venv manually, never hand-edit
    `uv.lock` or dependency arrays.
- **Build backend:** `hatchling`.
- Dev dependencies: `ruff` (lint/format), `mypy` (types), `pytest` + `pytest-cov`.

## Layout

- `src/<package>/` layout; domain logic in `core/` with minimal I/O.
- `tests/` mirrors `src/`; entry point declared in `[project.scripts]`.
- Standard task targets (via `justfile.agent` when present, else the project
  `justfile`): `install`, `run`, `fix`, `check`, `typecheck`, `test`, `clean`.
  Prefer `just -f justfile.agent check` as the single-turn QA gate.

## Quality gates

- **Ruff**: 88-column lines, double quotes, sorted imports.
- **mypy strict**: no implicit optional, no untyped defs.
- **pytest**: coverage ≥ 72%; markers `unit`, `integration`, `slow`.
- Imports: absolute for stdlib/third-party, relative for local; ordering
  stdlib → third-party → local; `from __future__ import annotations`; no
  wildcard imports; lazy-import heavy dependencies; declare `__all__`.

## Code rules

- Google-style docstrings and full type hints.
- Modern typing only: `list[str]`, `dict[str, int]`, `X | None` — never
  `typing.List`/`Dict`/`Optional`/`Union`.
- Catch specific exceptions; never bare `except`; log before re-raising; use a
  bare `raise` to preserve the traceback.
- Use context managers for resources; Pydantic for data models and config
  (`ConfigDict(strict=True)` where security-sensitive); `logging`, never
  `print`, for diagnostics.
- No mutable defaults, global state, or magic numbers.
- Pydantic: constrain with `Field(...)`, validate cross-field with
  `model_validator`, serialize with `model_dump`/`model_validate`.

## Security

- Never deserialize untrusted data with `pickle.load`, `yaml.load` (use
  `yaml.safe_load`), or `jsonpickle`.
- No `eval`/`exec`; treat `getattr`/`setattr` on user input with care.
- `subprocess.run([...])` with an argument list, never `shell=True` (if
  unavoidable, `shlex.quote`).
- Parameterized SQL only — never f-strings/`%`/`.format()` to build queries.
- Use `secrets`, not `random`; `sha256`+ / `bcrypt` for passwords, never
  `md5`/`sha1` for security.
- Audit for: shell injection, SQL string building, hardcoded secrets, PII in
  logs, overly broad CORS, path traversal, `DEBUG=True` in production.

## Tools

`bandit` (security), `pip-audit`/`safety` (dependencies), `ruff` security rules,
`detect-secrets`/`gitleaks` (secrets).
