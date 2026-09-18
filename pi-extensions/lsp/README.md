# pi-lsp

> **Unified Language Server Protocol (LSP) Code Intelligence Extension for Pi.**

Provides semantic code understanding, navigation, and cross-file refactoring tools
using the Language Server Protocol (LSP).

---

## 🌟 Architecture: Dual-Backend Router

`pi-lsp` dynamically switches between two execution backends:

```text
┌─────────────────────────────────────────────────────────────┐
│                      Pi Agent (LLM)                         │
│   Tools: lsp_definition, lsp_references, lsp_symbols, ...   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                Is $NVIM socket responsive?
               /                           \
        [ YES ]                             [ NO ]
           ▼                                   ▼
┌───────────────────────────┐       ┌───────────────────────────┐
│     Neovim RPC Client     │       │   Standalone LSP Client   │
│ • vim.lsp.buf_request_sync│       │ • On-demand JSON-RPC stdio│
│ • Zero extra RAM / 0ms    │       │ • Auto-detects runtime    │
│ • Unsaved buffer aware    │       │ • Lazy server startup     │
│ • Uses user's LSP config  │       │ • Hook-driven buffer sync │
└───────────────────────────┘       └───────────────────────────┘
```

1. **Editor-Attached Mode (`$NVIM` is set & responsive)**:
   Routes requests directly to the parent Neovim session's active `vim.lsp` clients.
   Shares warm project indices and unsaved buffer edits with 0ms startup and 0 MB extra RAM.
2. **Standalone Headless Mode (`$NVIM` is unset or Neovim offline)**:
   Spawns and manages headless language servers over JSON-RPC stdio on-demand for CLI,
   tmux, and subagent child sessions.

---

## 🛠️ Unified Tools

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `lsp_definition` | `path`, `line`, `col` | Jump directly to symbol definitions or declarations with code preview snippet. |
| `lsp_references` | `path`, `line`, `col`, `include_declaration?`, `limit?` | Find all call sites and usages across the project. |
| `lsp_symbols` | `path?`, `query?`, `scope?` (`document`/`workspace`) | Extract structural symbol outlines (classes, methods, functions) or search workspace symbols. |
| `lsp_call_hierarchy` | `path`, `line`, `col`, `direction?` (`incoming`/`outgoing`/`both`) | Inspect callers (who calls this function) and callees (what this function calls). |
| `lsp_hover` | `path`, `line`, `col` | Inspect type signatures, inferred types, and docstrings. |
| `lsp_diagnostics` | `path?`, `line?`, `severity?` (`error`/`warning`/`all`) | Query live compiler and linter diagnostics across files. |

---

## 🚀 Auto-Detected Language Servers (Headless Mode)

When running in headless mode, `pi-lsp` detects project markers and spawns the optimal server lazily:

- **Python**:
  - `pyright` (from `.venv/bin/pyright-langserver` or `uv run --with pyright pyright-langserver --stdio`)
  - `ruff server` (native fast diagnostics & AST)
  - `ty` (type checking)
- **TypeScript / JavaScript**:
  - `vtsls` or `typescript-language-server`
  - `npx @vtsls/language-server --stdio`
- **Rust**:
  - `rust-analyzer`
- **Go**:
  - `gopls`

---

## ⌨️ Slash Commands

- `/lsp` — Display active backend mode, running language server processes, open documents, and diagnostics summary.

---

## 📦 Installation & Linking

```bash
just link-extensions lsp
```
