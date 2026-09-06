# 🧩 pi-extension-neovim

> **Native Neovim RPC extension for the [Pi coding agent](https://pi.dev)**
> Connects Pi directly to its parent Neovim editor session via `$NVIM` Unix socket.

---

## 🌟 Why this extension?

When running Pi inside a Neovim terminal pane or split, Pi by default only interacts with files saved to disk.

With this extension, Pi becomes fully **editor-aware**:
* 👁️ **Live Context Awareness:** Automatically detects which file and line you have open in your active editor split.
* 📝 **In-Memory Buffer Inspection:** Reads unsaved in-memory edits directly from Neovim before you write them to disk.
* ⚡ **Remote Editor Commands:** Allows Pi to execute Ex commands (e.g. `:checktime` to reload buffers, `:edit`, or custom Lua
functions).
* 🪶 **Zero Heavy Dependencies:** Lightweight TypeScript implementation communicating directly via Neovim's native `--server` RPC
interface.

---

## 🛠️ Provided Tools & Capabilities

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `nvim_get_context` | `include_buffers` *(bool, optional)* | Returns active file path, relative path, cursor line/column, filetype,
modified status, and a list of all open buffers. |
| `nvim_read_buffer` | `target` *(string, optional)* | Reads the live in-memory buffer content (even unsaved edits) for the active file
or a specified buffer name/number. |
| `nvim_command` | `command` *(string, required)* | Sends and executes an Ex command to the parent Neovim session (e.g. `:checktime`,
`:w`). |

---

## 📦 Installation

### 1. Prerequisites
* **[Pi Coding Agent](https://pi.dev)** (`npm install -g @mariozechner/pi` or via curl)
* **Neovim 0.9+** (tested on Neovim 0.11 / 0.12)

### 2. Install the Extension
Clone or link `neovim.ts` into your global Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions

# Option A: Symlink directly from your cloned repo
ln -s "$(pwd)/neovim.ts" ~/.pi/agent/extensions/neovim.ts

# Option B: Direct copy
cp neovim.ts ~/.pi/agent/extensions/neovim.ts
──────
## ⚙️ Recommended Neovim Setup (Lua)

While the extension includes native VimScript fallbacks, adding the following lightweight Lua helpers to your Neovim config (init.lua or
lua/ai.lua) provides intelligent filtering (e.g. automatically ignoring Pi's own terminal buffer):

-- Helper for Pi agent: Get active editor context
_G.PiGetContext = function()
  local cur_win = vim.api.nvim_get_current_win()
  local cur_buf = vim.api.nvim_get_current_buf()
  local buftype = vim.bo[cur_buf].buftype

  -- If current window is a terminal/chat split, find the active code buffer window
  if buftype == "terminal" or buftype == "nofile" or buftype == "prompt" then
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      local b = vim.api.nvim_win_get_buf(win)
      local bt = vim.bo[b].buftype
      if bt == "" and vim.api.nvim_buf_get_name(b) ~= "" then
        cur_win = win
        cur_buf = b
        break
      end
    end
  end

  local file_path = vim.api.nvim_buf_get_name(cur_buf)
  local rel_path = file_path ~= "" and vim.fn.fnamemodify(file_path, ":~:.") or ""
  local file_name = file_path ~= "" and vim.fn.fnamemodify(file_path, ":t") or ""
  local cursor = vim.api.nvim_win_get_cursor(cur_win)
  local total_lines = vim.api.nvim_buf_line_count(cur_buf)
  local modified = vim.bo[cur_buf].modified
  local ft = vim.bo[cur_buf].filetype

  -- Collect listed buffers
  local listed = {}
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_get_option_value("buflisted", { buf = b }) then
      local bname = vim.api.nvim_buf_get_name(b)
      if bname ~= "" and vim.bo[b].buftype == "" then
        table.insert(listed, {
          bufnr = b,
          name = vim.fn.fnamemodify(bname, ":~:."),
          modified = vim.bo[b].modified,
        })
      end
    end
  end

  return vim.json.encode({
    active_file = file_path,
    relative_file = rel_path,
    file_name = file_name,
    filetype = ft,
    cursor_line = cursor[1],
    cursor_col = cursor[2] + 1,
    total_lines = total_lines,
    modified = modified,
    open_buffers = listed,
  })
end

-- Helper for Pi agent: Read in-memory buffer content
_G.PiGetBufferContent = function(target)
  local bufnr = 0
  if target and target ~= "" then
    bufnr = vim.fn.bufnr(target)
    if bufnr == -1 then
      return ""
    end
  else
    -- Use the active code buffer if in a terminal split
    local cur_buf = vim.api.nvim_get_current_buf()
    if vim.bo[cur_buf].buftype == "terminal" then
      for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
        local b = vim.api.nvim_win_get_buf(win)
        if vim.bo[b].buftype == "" and vim.api.nvim_buf_get_name(b) ~= "" then
          bufnr = b
          break
        end
      end
    else
      bufnr = cur_buf
    end
  end

  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  return table.concat(lines, "\n")
end
──────
## 🔍 How It Works

1. When Neovim starts a terminal or subshell, it exposes its active RPC server socket in the $NVIM environment variable.
2. When Pi starts, the extension checks for process.env.NVIM.
3. If detected, the extension registers RPC tools that execute non-blocking queries via nvim --server $NVIM --remote-expr and nvim --
server $NVIM --remote-send.
4. If Pi is run outside of Neovim, the extension remains completely inactive without overhead.
──────
## 📜 License

MIT
