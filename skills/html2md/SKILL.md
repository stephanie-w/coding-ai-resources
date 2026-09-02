---
name: html2md
description: Extract and convert web pages to clean Markdown using the skill script at `40_Resources/Skills/html2md/scripts/html2md.py` executed with `uv`. Removes navigation, ads, headers, footers, scripts, and clutter to save tokens and produce clean notes for the Obsidian vault. Use whenever the user provides a URL to read, analyze, convert, or archive as markdown. Do NOT use for raw markdown files or URLs ending in .md.
---

# html2md Skill

Use the colocated helper script [html2md.py](./scripts/html2md.py) executed via `uv` to fetch and convert web pages into clean, readable Markdown. This utility strips boilerplate navigation, ads, header/footer elements, scripts, and invisible formatting characters to save tokens and format clean notes for the Obsidian vault.

## Prerequisites

- Python 3.10+
- `uv` package and script runner

Dependencies (`requests`, `html2text`, `beautifulsoup4`) are declared in inline script metadata (PEP 723) inside [html2md.py](./scripts/html2md.py) and are automatically resolved and executed by `uv`.

## Usage

### 1. Basic Conversion (Default Output: `<hostname>.md`)

```bash
uv run scripts/html2md.py "<url>"
```
 
### 2. Save Locally in a docs directory

```bash
mkdir docs && uv run html2md.py "<url>" -o "docs/<note-name>.md"
```

### 3. Verbose Mode & Custom Timeout

```bash
uv run scripts/html2md.py "<url>" -o "docs/<note-name>.md" --timeout 45 -v
```

## Options Reference

| Flag | Argument | Description |
|---|---|---|
| `-o`, `--output` | `PATH` | Custom path for the generated markdown file. |
| `--timeout` | `SECONDS` | Request timeout in seconds (default: `30`). |
| `-v`, `--verbose` | | Print fetch and cleaning progress to `stderr`. |
| `-h`, `--help` | | Display script help message and usage. |
