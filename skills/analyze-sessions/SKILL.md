---
name: analyze-sessions
description: Analyze past pi agent sessions stored under ~/.pi/agent/sessions. Use when the user asks about cost (totals, per project, per model, per day), reflection / self-improvement (mining corrections, friction patterns), viewing past sessions, or searching transcripts. Triggers on "reflect", "extract learnings", "mine prompt patterns", "session cost".
---

# Analyze Sessions & Reflection

Tools for querying past pi sessions and extracting self-improvement patterns. All scripts are stdlib Python 3, no dependencies, and read directly from `~/.pi/agent/sessions/`.

---

## Data Shape (One-Liner)

Each session is a JSONL file. Records are `session` (header with `cwd`, `id`, `timestamp`), `model_change`, `thinking_level_change`, and `message` (roles: `user`, `assistant`, `toolResult`). Assistant messages carry `usage.cost` already split into input/output/cacheRead/cacheWrite/total. Subagent transcripts live nested inside the parent session's directory.

---

## Scripts

All scripts share the same filter vocabulary (see "Shared filters" below). Run them with `python3` from anywhere:

```bash
python3 ~/.pi/agent/skills/analyze-sessions/scripts/<script>.py [args]
```

### `cost.py` — Cost Rollups

Subagent costs are **included by default** so totals reflect actual spend. Pass `--show-subagents` to see the subagent share per row, or `--no-subagents` to exclude.

```bash
# Last 7 days, broken down by day (default)
python3 cost.py

# Last 30 days, top 10 projects by spend
python3 cost.py --since 30d --by project --limit 10

# Cost-per-model (each assistant message credited to its own model)
python3 cost.py --since 30d --by model

# The 10 most expensive sessions of the last month
python3 cost.py --since 30d --by session --limit 10

# Cost of one project, all time
python3 cost.py --cwd /path/to/your/project

# Grand total only
python3 cost.py --since 30d --by total

# Machine-readable
python3 cost.py --since 30d --by day --json
```

Groupings: `total`, `day`, `project`, `model`, `session`. When grouping, `--limit` caps groups, not sessions.

---

### `prompts.py` — Prompt Mining & Reflection

Dumps raw human user prompts grouped by project. Prompts above `--max-chars` are dropped because they are almost always pasted context, keeping only real human instructions.

```bash
# Default: markdown dump, max 2000 chars per prompt
python3 prompts.py --since 30d

# Filter strictly on user corrections (never, always, wrong, stop, don't, etc.)
python3 prompts.py --since 14d --corrections

# One project's prompts
python3 prompts.py --cwd /path/to/your/project --since 30d

# Prompts matching specific keywords
python3 prompts.py --grep "uv run" --since 60d

# Machine-readable JSONL dump
python3 prompts.py --since 7d --format jsonl
```

#### Self-Improvement / Reflection Workflow:
1. Run `python3 prompts.py --since 30d --corrections`.
2. Group corrections by recurring themes (e.g., repeatedly corrected on environment setup, forbidden tools, formatting).
3. Propose concrete additions to `agents/base.agent.md`, `instructions/`, or `flavors/` with exact diffs for user confirmation.

---

### `show_session.py` — Render One Session as Markdown

```bash
# The most recent session
python3 show_session.py --latest

# A specific session by id prefix (8 chars is enough)
python3 show_session.py --session 019e475b

# The most recent session in a project
python3 show_session.py --latest --cwd /path/to/your/project

# Include subagent transcripts inline below
python3 show_session.py --session 019e475b --include-subagents-content

# Drop thinking entirely / show fewer chars
python3 show_session.py --session 019e475b --max-thinking -1 --max-tool-output 800
```

---

### `search.py` — Search Across Transcripts

Substring by default, regex with `--regex` (smart-case). Searches both user and assistant text by default.

```bash
# Substring across everything
python3 search.py "supabase RLS"

# Only human prompts, last 60 days
python3 search.py "global instruction" --in user --since 60d

# Regex search
python3 search.py --regex "TODO\\(.+\\)"

# More context per match
python3 search.py "rate limit" --context 2
```

---

## Shared Filters

Available on **all scripts**:

| Flag | Meaning |
| :--- | :--- |
| `--since WHEN` / `--until WHEN` | `YYYY-MM-DD`, ISO datetime, or relative: `7d`, `2w`, `3h`, `30m` |
| `--cwd SUBSTR` | Substring match on session `cwd`. Repeatable. |
| `--model SUBSTR` | Substring match on model ID. Repeatable. |
| `--provider {anthropic,openai,google}` | Match provider |
| `--session ID` | Session ID or prefix |
| `--include-subagents` / `--no-subagents` | Override script default |
| `--limit N` | Cap items returned |
| `--min-cost USD` | Drop sessions below spend threshold |
| `--min-messages N` | Drop short sessions |
| `--errors-only` | Only sessions with at least one `toolResult.isError` |
| `--grep SUBSTR` | Substring search across user prompts |

---

## Notes

- All paths are read-only; scripts never modify session files.
- The library (`scripts/sessions.py`) is reusable for ad-hoc Python analysis.
- Scans take ~1 second over hundreds of sessions with zero LLM token cost.
