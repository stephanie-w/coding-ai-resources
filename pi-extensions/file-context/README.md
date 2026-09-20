# File Context

This extension comes from upstream:

**→ [narumiruna/pi-extensions (packages/pi-file-context)](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-file-context)**

Interactive TUI file and code browser for Pi (`/file-context` or `Ctrl+Shift+X`). Browse project files, preview bounded line numbers, select exact line ranges or Git diff hunks, and attach them with Git provenance (commit SHA, branch, status) directly into your next prompt.

---

## Key Features

- **Interactive TUI Browser:** Shortcut `Ctrl+Shift+X` or `/file-context browse` to explore project hierarchy and search file names/contents.
- **Exact Line & Hunk Selection:** Space-anchored line range selection and Git hunk selection (`[` / `]`).
- **Git Provenance:** Attaches metadata (HEAD SHA, branch, file status, diffs) with bounded token estimates.
- **External Editor Hook:** Press `Ctrl+G` to open the file in your configured external editor and auto-reload changes.
- **Snapshot Review:** Review, edit, or remove queued context snippets before submitting your prompt.

---

## Commands & Shortcuts

| Shortcut / Command | Description |
| :--- | :--- |
| `Ctrl+Shift+X` | Open the interactive file context browser directly |
| `/file-context` | Open the main menu (add context snippet, review queued snippets) |
| `/file-context browse` | Open browser directly |
| `Ctrl+F` | Toggle between file name search and content search |
| `Space` + `Up`/`Down` | Anchor and extend line selection range |
| `[` / `]` | Select changed Git hunks |
| `b` / `h` / `d` | Show Git blame / history / diff context |
| `Ctrl+G` | Open worktree file in external editor |

---

## Installation

### From npm (recommended)

```bash
pi install npm:@narumitw/pi-file-context
```

### Local vendor build

```bash
git clone https://github.com/narumiruna/pi-extensions.git vendor/pi-file-context
cd vendor/pi-file-context/packages/pi-file-context
npm install && npm run build
pi install "$PWD"
```

Reload Pi after installing:
```text
/reload
```
