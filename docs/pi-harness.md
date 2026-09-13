# Pi Harness: Persona, Flavors, and Launcher

How this repository composes a Pi session's system prompt, and how to use it day
to day. This is the Pi-specific guide; the rest of the catalog is harness-agnostic.

## Mental model

A Pi session's system prompt is assembled from independent sources:

```text
Pi default prompt
  + appended files     (--append-system-prompt, APPEND_SYSTEM.md)
  + context files      (AGENTS.md / CLAUDE.md, global + project)
  + skills             (name + description; bodies loaded on demand)
```

This repo places its pieces deliberately:

| Piece | File | How it reaches the prompt | Scope |
| :--- | :--- | :--- | :--- |
| Base persona | `agents/base.agent.md` | global context file `~/.pi/agent/AGENTS.md` (symlink) | every session |
| Flavor overlay | `flavors/<name>.md` | `--append-system-prompt` via `just pi <name>` | one session |
| Project rules | `<project>/AGENTS.md` | context file (copied by `just setup-python`) | that project |
| Procedures | `skills/*` | skill discovery | on demand |

## 1. Base persona — one-time setup

`agents/base.agent.md` is the always-on persona. Install it once as Pi's
**global** context file:

```bash
just link-persona
# → ~/.pi/agent/AGENTS.md -> <repo>/agents/base.agent.md
```

Because it is a context file (not an appended prompt), it:

- loads for **bare `pi` too** — no alias or wrapper required;
- composes with flavors and `just teach` (context files are independent of
  `--append-system-prompt`);
- appears in the startup header under loaded context files.

Verify with the startup header. To undo: `rm ~/.pi/agent/AGENTS.md`.

If `PI_CODING_AGENT_DIR` is set, the link lands at
`$PI_CODING_AGENT_DIR/AGENTS.md`.

## 2. Flavors — per session

A flavor is a short overlay appended **after** the base persona. It is **fixed
for the session**; there is no switch command. See [`flavors/README.md`](../flavors/README.md).

```bash
just pi            # base persona only
just pi plan       # base persona + flavors/plan.md
```

Model, thinking level, and tools are **not** part of a flavor — pass them as
normal Pi flags (or use `/model` / `/thinking`).

## 3. Launcher

Inside the repo:

```bash
just pi [flavor...] [pi args...]
```

Zero or more leading flavors compose in order (later overrides earlier):

```bash
just pi                  # base persona only
just pi plan             # base + plan
just pi rapid python     # base + rapid + python
just pi rapid --model deepseek/deepseek-v4-flash "do the thing"
```

From anywhere — add to `~/.bashrc`:

```bash
pih() { just -f "$HOME/DEV/coding-ai-resources/justfile" pi "$@"; }
```

`just` searches upward for a justfile, so bare `just pi` only works inside the
repo; `-f` makes `pih` work from any directory. Do **not** name the function
`pi` — it would shadow the real binary.

### Argument order matters

- **Leading non-flag arguments are all flavors** (`pih rapid python`). The first
  argument that starts with `-` ends the flavor list.
- **Later flavors override earlier ones**, because `--append-system-prompt`
  stacks in order. Put a broad posture first and specific overrides last.
- A leading non-flag that is not a flavor is treated as a typo and errors.
- Pi flags and their values must be **separate tokens**: `--model foo/bar`, not
  `"--model foo/bar"`. Quoting them together makes Pi see one unknown option.
- Just options (`-f`, `--fmt`, …) go **before** the recipe; everything else goes
  after `pi`.

If you want a default model, append it *after* `"$@"` so a flavor can still come
first — but note the explicit `--model` then cannot override it:

```bash
pihd() { just -f "$HOME/DEV/coding-ai-resources/justfile" pi "$@" --model deepseek/deepseek-v4-flash; }
```

Inspect your current definition with `type pih` (and `unalias pih` if an old
alias is shadowing the function).

---

## Scenarios

### Everyday coding session

```bash
pih
```

Base persona only. No flavor.

### Plan a feature before touching code

```bash
pih plan
```

Read-only posture; produces `PLAN.md`.

### Implement the plan (new session, deliberate)

```bash
pih
```

Read `PLAN.md` and implement. A new session is intentional: flavors are fixed
per session, and the plan file is the handoff artifact — the same pattern as
`skills/session-handoff`.

### Compose layers (behavior + domain)

```bash
pih rapid python
```

Flavors stack in order; later ones can override earlier ones.

### A hard subproblem needs a stronger model

```bash
pih --model anthropic/claude-sonnet-4-5
# or, mid-session: /model
```

Model is a runtime knob, not a flavor.

### Teaching session

```bash
just teach
```

Uses `agents/teach.agent.md` plus a model default. It layers on top of the
global base persona.

### Project-scoped rules

```bash
just setup-python /path/to/project
```

Copies `justfile.agent` + `AGENTS.md` into the project. The project context
layers on top of the global persona.

### New machine / fresh checkout

```bash
just link-persona      # global base persona
just link-extensions   # all pi extensions (gondolin, bash-guard, neovim, git-checkpoint)
just install-global    # core skills pack
```

---

## Reference: prompt sources

| Mechanism | Scope | Composes? | Notes |
| :--- | :--- | :--- | :--- |
| `~/.pi/agent/AGENTS.md` | global, automatic | ✅ | base persona; recommended home |
| `--append-system-prompt <file>` | per invocation | ✅ (stacks) | flavors |
| `APPEND_SYSTEM.md` (global/project) | automatic | ❌ **suppressed** when any `--append-system-prompt` is used | don't mix with flavors |
| `~/.pi/agent/SYSTEM.md` | global | replaces the prompt | not for a persona |
| `--no-context-files` | per invocation | disables context files | disables the base persona too |

`--append-system-prompt` accepts a **file path** (contents are read) or literal
text. A path containing a quoted `~` is **not** expanded — use `$HOME` or an
absolute path, or the literal path string gets appended instead of the file.

## What belongs where

| Concern | Home |
| :--- | :--- |
| Who the agent is | `agents/base.agent.md` (global context file) |
| Session posture | `flavors/<name>.md` |
| Persistent project rules | project `AGENTS.md` |
| Reusable procedure | a skill |
| Per-message nudge | a prompt snippet |
| Enforced behaviour | an extension |
| Copilot-style policy (`applyTo`) | `instructions/` — **not loaded by Pi** |
