# ==============================================================================
# Python & uv QA Gates (Concise / Token-Optimized)
# ==============================================================================

# Run tests via pytest. Returns only failures.
test filter="":
    #!/usr/bin/env bash
    FILTER="{{filter}}"
    ARGS=("-q" "--tb=short" "--no-header")
    [ -n "$FILTER" ] && ARGS+=("-k" "$FILTER")
    uv run pytest "${ARGS[@]}" 2>&1 | grep -E "(FAILURES|FAILED|ERROR|=== short test summary)" | head -n 40 || echo "✓ All tests passed."

# Run ruff linter. Output only concise errors.
lint:
    @uv run ruff check . --output-format=concise | head -n 30 || echo "✓ Lint clean."

# Automatically apply safe fixes and formatting
fix:
    @uv run ruff check --fix --quiet .
    @uv run ruff format --quiet .
    @echo "✓ Code formatted and safe lint fixes applied."

# Run fast type checker 'ty' via uv
typecheck:
    @if command -v ty >/dev/null 2>&1; then \
        ty check 2>&1 | head -n 30; \
    else \
        uv run ty check 2>&1 | head -n 30 || echo "✓ Types clean."; \
    fi

# Single-turn QA gate (lint + typecheck + test)
check:
    @just -f {{justfile()}} lint
    @just -f {{justfile()}} typecheck
    @just -f {{justfile()}} test
