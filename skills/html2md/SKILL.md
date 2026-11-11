---
name: html2md
description: Extract and convert web pages to clean Markdown using the colocated `scripts/html2md.py` helper executed with `uv`. Removes navigation, ads, headers, footers, scripts, and clutter to save tokens. Use whenever a URL needs to be fetched, read, analyzed, or archived as Markdown. Do NOT use for raw markdown files or URLs ending in .md.
---

# html2md Skill

Use the colocated helper script [`scripts/html2md.py`](./scripts/html2md.py) executed via `uv` to fetch and convert web pages into clean, readable Markdown. This utility strips boilerplate navigation, ads, header/footer elements, scripts, and invisible formatting characters to save tokens.

## Prerequisites

- Python 3.10+
- `uv` package and script runner

Dependencies (`requests`, `html2text`, `beautifulsoup4`) are declared in inline script metadata (PEP 723) inside [`scripts/html2md.py`](./scripts/html2md.py) and are automatically resolved and executed by `uv`.

## Usage

Resolve the path to `scripts/html2md.py` relative to this `SKILL.md` directory (`<skill_dir>/scripts/html2md.py`).

### 1. Read Directly to Stdout (Recommended Inside Git Repositories)

When inspecting web pages or documentation inside a git repository/worktree, use `--stdout` (or write to `/tmp/`) so you do not leave untracked files in the working tree:

```bash
uv run <skill_dir>/scripts/html2md.py "<url>" --stdout
```

### 2. Save to a Temporary or Specific File

```bash
uv run <skill_dir>/scripts/html2md.py "<url>" -o "/tmp/page.md"
```

### 3. Basic File Conversion (Default Output: `./<hostname>.md`)

```bash
uv run <skill_dir>/scripts/html2md.py "<url>"
```

### 4. Verbose Mode & Custom Timeout

```bash
uv run <skill_dir>/scripts/html2md.py "<url>" -o "docs/<note-name>.md" --timeout 45 -v
```

## Options Reference

| Flag | Argument | Description |
|---|---|---|
| `--stdout` | | Print converted Markdown directly to `stdout` without writing a file. |
| `-o`, `--output` | `PATH` | Custom path for the generated markdown file (or `-` for `stdout`). |
| `--timeout` | `SECONDS` | Request timeout in seconds (default: `30`). |
| `-v`, `--verbose` | | Print fetch and cleaning progress to `stderr`. |
| `-h`, `--help` | | Display script help message and usage. |
