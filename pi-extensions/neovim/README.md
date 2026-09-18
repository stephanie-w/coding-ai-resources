# 🧩 pi-extension-neovim

> **Native Neovim RPC integration for the [pi coding agent](https://pi.dev)**
> Connects pi directly to its parent Neovim session via the `$NVIM` Unix socket.

When pi runs inside a Neovim `:terminal`, this extension makes it **editor-aware**:
it reads live editor state, keeps buffers in sync after edits, and lets Neovim
trigger pi workflows with a keystroke.

---

## ✨ Features

- **Dynamic context** — active file, cursor line/column, dirty state, visual
  selection (or 50 surrounding lines), and **LSP diagnostics**, all read live
  from Neovim.
- **Zero-friction buffer sync** — when pi runs `write`/`edit` on a file open in
  Neovim, a fire-and-forget **RPC notification** reloads the buffer from disk.
  Unmodified buffers reload in place; the undo tree and window views are
  preserved. Buffers with unsaved changes are skipped and the user is warned.
- **Neovim-triggered commands** — `:Pi /<command>` and `_G.PiNvim.send()`
  forward any pi slash command or prompt to the pi terminal, capturing the
  current visual selection first. There are no built-in presets.
- **Self-contained** — speaks Neovim's MessagePack-RPC protocol directly over
  the socket. No Lua config is required, though helper bindings are installed
  automatically.
- **Graceful degradation** — if `$NVIM` is unset (pi run outside Neovim), the
  extension registers nothing and pi behaves exactly like a normal CLI agent.

---

## 🔍 How it works

1. Neovim exposes its RPC socket path in the `$NVIM` environment variable.
2. The extension opens a long-lived MessagePack-RPC connection to that socket.
3. Tools query and act on Neovim through `nvim_exec_lua`.
4. If the socket cannot be opened, it falls back to
   `nvim --server "$NVIM" --remote-expr` transparently.
5. When pi is run outside Neovim, the extension is completely inert.

---

## 📦 Installation

### 1. Prerequisites

- **pi coding agent** (`npm install -g @earendil-works/pi-coding-agent`)
- **Neovim 0.9+** (tested on 0.12)

### 2. Install the extension

```bash
mkdir -p ~/.pi/agent/extensions

# Option A: symlink from a cloned repo
ln -s "$(pwd)/neovim.ts" ~/.pi/agent/extensions/neovim.ts

# Option B: copy
cp neovim.ts ~/.pi/agent/extensions/neovim.ts
```

Reload with `/reload` or restart pi. The extension is a single self-contained
TypeScript file — no `npm install`, no build step, no Neovim config required.

---

## 🛠️ Tools

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `nvim_get_context` | `include_buffers?`, `context_lines?`, `include_diagnostics?` | Active file, cursor position, dirty state, visual selection (or surrounding source), LSP diagnostics, and open buffers. |
| `nvim_read_buffer` | `target?` | Live in-memory buffer contents, including unsaved edits. Defaults to the active code buffer. |
| `nvim_command` | `command`, `buffer?` | Run an Ex command against the user's active code buffer (not pi's terminal). Pass `buffer` (path/number) to target another file. `:edit!`/`:checktime` are refused when the buffer is dirty. |
| `nvim_diagnostics` | `scope?` (`line`/`buffer`), `severity?` (`error`/`warning`/`all`) | LSP diagnostics for the cursor line or the whole buffer. |
| `nvim_lsp_definition` | `path?`, `line`, `col` | Go to symbol definition or declaration using Neovim's active LSP client. Returns file location and preview snippet. |
| `nvim_lsp_references` | `path?`, `line`, `col`, `include_declaration?`, `limit?` | Find all usages and call sites across the project using Neovim's active LSP client. |
| `nvim_lsp_symbols` | `path?`, `query?`, `scope?` (`document`/`workspace`) | Retrieve structural symbol outline for a file (classes, methods, functions) or search symbols across the workspace. |
| `nvim_lsp_call_hierarchy` | `path?`, `line`, `col`, `direction?` (`incoming`/`outgoing`/`both`) | Inspect incoming callers (who calls this) and outgoing callees (what this calls) for a function/method. |
| `nvim_lsp_hover` | `path?`, `line`, `col` | Inspect type signatures, inferred types, and docstrings for a symbol at cursor position. |

The context tool automatically ignores pi's own terminal buffer and reports the
code buffer you were last using in the current tabpage. All LSP tools query the
active language servers attached to the buffer in Neovim (`vim.lsp.buf_request_sync`),
sharing warm indices and unsaved buffer states with zero extra memory overhead.

---

## ⌨️ Neovim bindings

At startup the extension installs a small `PiNvim` helper into the running
Neovim session. It forwards pi slash commands from Neovim; there are no built-in
presets — you decide what to send.

- `:Pi /<command>` — user command (e.g. `:Pi /review`). The argument must start
  with `/` and is passed to pi verbatim.
- `_G.PiNvim.send(command)` — Lua API. Accepts either a `/command` or a name
  defined in `_G.PiNvim.actions`.

When invoked from visual mode, the selection is captured into
`vim.g.pi_selection` before the command is sent, so pi can read it even after
Neovim leaves visual mode. The selection expires after `vim.g.pi_selection_ttl`
seconds (default `300`).

Bind your own keys to whatever pi command, prompt, or skill you want:

```lua
vim.keymap.set("x", "<leader>ae", function() _G.PiNvim.send("/explain") end, { desc = "pi: explain selection" })
vim.keymap.set("x", "<leader>ar", function() _G.PiNvim.send("/refactor") end, { desc = "pi: refactor selection" })
vim.keymap.set("n", "<leader>af", function() _G.PiNvim.send("/fix") end, { desc = "pi: fix diagnostics" })
```

Optional aliases keep keymaps short:

```lua
_G.PiNvim.actions.review = "/review"
vim.keymap.set("n", "<leader>ag", function() _G.PiNvim.send("review") end)
```

The commands are ordinary pi slash commands, prompt templates, or skills, so
they can also be typed directly into pi or shared like any other prompt. The
extension's only job is to forward them and attach the live selection.

The binding sends to the terminal channel running pi. If the terminal cannot be
detected, set it explicitly:

```lua
vim.g.pi_term_channel = <channel id>  -- see :lua print(vim.bo.channel) in the pi terminal
```

---

## 🔄 Buffer sync details

Before pi writes to a file, it checks Neovim for that path:

- **Dirty buffer** → the write is **blocked** and a conflict **lock** is set.
  While locked, all mutating tools (`write`, `edit`, `bash`, `powershell`,
  `nvim_command`) are blocked, and `nvim_get_context` reports the conflict at
  the top of its output. The lock clears automatically once the user saves or
  discards the buffer, so a later retry succeeds. This is enforced in the
  extension, not by asking the model to behave.

After a successful `write`/`edit`, `tool_result` watchers keep Neovim in sync:

- **Unmodified buffer** → reloaded from disk with a targeted `:edit` inside
  `nvim_buf_call`, then all window views are restored. Neovim's `'undoreload'`
  keeps the undo tree intact.
- **Modified buffer** (race: dirtied between the check and the write) → left
  untouched and the user is warned via `vim.notify`.
- **Not loaded** → ignored.

The reload is emitted as an RPC **notification** (no reply awaited).

`nvim_command` also targets the user's code buffer rather than pi's terminal
buffer, and refuses force-reload commands (`:edit!`, `:checktime`) that would
discard unsaved changes.

---

## ⚙️ Configuration

| Setting | Type | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `$NVIM` | env | — | Neovim RPC socket. Required to activate the extension. |
| `PI_NVIM_TRANSPORT` | env | `auto` | Set to `cli` to force the `nvim --server` fallback (debugging). |
| `vim.g.pi_term_channel` | Lua | auto-detect | Pin the terminal channel running pi. |
| `vim.g.pi_selection_ttl` | Lua | `300` | Seconds before a captured selection is considered stale. |

---

## 🩺 Troubleshooting

- **“`$NVIM` is set, but the Neovim RPC socket is not reachable.”** — The
  socket is stale or inaccessible. Try setting `PI_NVIM_TRANSPORT=cli`.
- **Keymaps do nothing** — pi's terminal could not be detected by name. Set
  `vim.g.pi_term_channel` to its channel id.
- **A buffer did not reload after an edit** — it had unsaved changes in Neovim.
  Save or revert the buffer, then run `:checktime` or `:e!`.- **No diagnostics** — LSP diagnostics are only present if an LSP client is
  attached to the buffer.

---

## 📜 License

MIT
