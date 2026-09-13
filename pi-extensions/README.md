# Pi agent extensions

TypeScript extensions for the [pi coding agent](https://pi.dev). Each directory is
self-contained and can be installed on its own.

- **neovim** : Native Neovim RPC integration. Gives Pi live awareness of active files, cursor positions, unsaved in-memory buffers, and remote command execution.
- **git-checkpoint** : Manual, durable, reversible git snapshots of the working tree via `/checkpoint` and `/rollback`, stored as refs under `refs/pi/checkpoints/`. Fully decoupled from `/tree` and `/fork`.
- **bash-guard** : Intercepts agent-issued `bash` tool calls and prompts before destructive commands (main session) or hard-blocks catastrophic ones (subagents).
- **gondolin** : Sandboxes all agent file and shell operations (`read`, `write`, `edit`, `bash`) inside an isolated Gondolin Linux micro-VM.
- **prompt-snippets** : Toggleable, per-message prompt fragments (`alt+s` / `/snippets`) that are prepended or appended to your message. Skips slash commands so templates and skills still expand.
- **ask-user-question** : Interactive multiple-choice / text clarification tool (`ask_user_question`) for Pi TUI. (Upstream: `amosblomqvist/pi-config`).
- **context-monitor** : Token/context budget indicator — footer badge, `/tokens` breakdown (exact totals + estimated composition), cache efficiency, and overflow surfacing.
- **pi-repl** : Python eval + inspection against the project's uv environment (`py_eval`, `py_inspect`). Stateless `uv run`, self-gates outside uv projects.

---

## Requirements

- pi installed (`npm install -g @earendil-works/pi-coding-agent`)
- The extension's own runtime dependencies installed (only **bash-guard** has any).
  `node_modules/` is git-ignored, so after cloning run:

  ```bash
  cd pi-extensions/bash-guard && npm install
  ```

Pi auto-discovers extensions from these locations:

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.pi/extensions/*.ts` | Project-local |
| `.pi/extensions/*/index.ts` | Project-local (subdirectory) |

Replace `~/` with `<project>/.pi/` in the examples below to install per-project
instead of globally. After any change, run `/reload` inside pi (auto-discovered
extensions hot-reload; a restart also works).

---

## Method 1 — Symlink (recommended)

Links the extension into the discovery directory. Edits in this repo take effect
after `/reload`, so it is the best option during development.

```bash
mkdir -p ~/.pi/agent/extensions

# Single-file extension (neovim) → link the file
ln -s "$PWD/pi-extensions/neovim/neovim.ts" ~/.pi/agent/extensions/neovim.ts

# Directory extension (git-checkpoint) → link the whole directory
ln -s "$PWD/pi-extensions/git-checkpoint" ~/.pi/agent/extensions/git-checkpoint
```

Link the **whole directory** for directory extensions. This keeps `package.json`
(and, for bash-guard, `node_modules/`) resolvable next to `index.ts`.

> **bash-guard** also needs `npm install` run inside the directory first
> (see [Requirements](#requirements)); a directory symlink keeps those
> `node_modules` in scope. Alternatively, pi resolves `node_modules` from parent
> directories, so running `npm install` in `pi-extensions/` covers it too.

To remove a symlinked extension, delete the link (`rm ~/.pi/agent/extensions/<name>*`).
The source in this repo is untouched.

## Method 2 — Copy

Copies a frozen snapshot into the discovery directory. Simple and independent of
this repo's location, but it does not track later edits here.

```bash
mkdir -p ~/.pi/agent/extensions

# Single-file extension
cp pi-extensions/neovim/neovim.ts ~/.pi/agent/extensions/neovim.ts

# Directory extension → copy the whole directory
cp -R pi-extensions/git-checkpoint ~/.pi/agent/extensions/git-checkpoint
```

For **bash-guard**, either copy `node_modules/` along with the directory or run
`npm install` after copying.

Re-run the copy and `/reload` to pick up updates.

## Method 3 — Install as a pi package

Registers the extension through pi's package system. pi reads the path from
`~/.pi/agent/settings.json`, so it survives restarts and can be managed with
`pi list` / `pi remove`. Nothing is copied — the path is referenced in place, and
directory packages are loaded using their `package.json` `pi.extensions` manifest.

```bash
# Directory packages (each has a package.json with a `pi.extensions` entry)
pi install /absolute/path/to/coding-ai-resources/pi-extensions/git-checkpoint
pi install /absolute/path/to/coding-ai-resources/pi-extensions/bash-guard
pi install /absolute/path/to/coding-ai-resources/pi-extensions/neovim
pi install /absolute/path/to/coding-ai-resources/pi-extensions/prompt-snippets

# A file path also works for single-file extensions
pi install /absolute/path/to/coding-ai-resources/pi-extensions/neovim/neovim.ts

# Project-local instead of global: add -l (use an absolute path,
# relative paths resolve against the settings file that records them)
pi install -l /absolute/path/to/coding-ai-resources/pi-extensions/git-checkpoint

# Manage / remove
pi list
pi remove pi-git-checkpoint   # package name from package.json
```

Equivalently, add the paths to `~/.pi/agent/settings.json` by hand:

```json
{
  "packages": ["/absolute/path/to/coding-ai-resources/pi-extensions/git-checkpoint"],
  "extensions": ["/absolute/path/to/coding-ai-resources/pi-extensions/neovim/neovim.ts"]
}
```

> Local paths are referenced, not copied — do not move or delete this repo after
> installing. For bash-guard, run `npm install` in its directory first.

---

## Quick test without installing

Load an extension for a single run only (installed to a temp dir, reverts on exit):

```bash
pi -e ./pi-extensions/git-checkpoint
pi -e ./pi-extensions/neovim/neovim.ts
```

## Verify

Inside pi, run `/help` (or `/reload`) and check for the extension's commands/tools:

- **neovim** → `nvim_get_context`, `nvim_read_buffer`, `nvim_command`, `nvim_diagnostics`
  (only active when launched from a Neovim terminal, i.e. `$NVIM` is set)
- **git-checkpoint** → `/checkpoint`, `/rollback`
- **bash-guard** → transparent `bash` interception; no commands of its own

Each extension's own `README.md` documents its behavior, configuration, and caveats.
