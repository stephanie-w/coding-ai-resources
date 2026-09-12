# Flavors

Session-scoped overlays appended to `agents/base.agent.md`. A flavor tunes how
the base persona operates for **one session** — it is not a persona and not a
reusable procedure.

A flavor is a plain markdown file named `<name>.md`. Launch it with:

```bash
just pi <name> [pi args...]
```

- `just pi` → base persona only.
- `just pi plan` → base persona + `flavors/plan.md`.
- `just pi plan --model deepseek/deepseek-v4-flash "do the thing"`.

The base persona is loaded globally (one-time `just link-persona`, see
[`docs/pi-harness.md`](../docs/pi-harness.md)), so `just pi` normally appends only the
flavor. If that global link is absent, `just pi` appends the base persona for
that session instead — no duplication either way.

## Fixed per session

The flavor is chosen at launch and **cannot be switched mid-session** — there is
no command for it. To change flavor, start a new session. This keeps the system
prompt (the cached prefix) stable and the transcript coherent.

Model, thinking level, and tools are **not** part of a flavor. Pass them as
normal pi flags, or use `/model` / `/thinking` mid-session.

## What belongs where

| Concern | Home |
| :--- | :--- |
| Session posture / mode | a **flavor** (this directory) |
| Always-on project rules | `AGENTS.md` (see `templates/AGENTS.md`) |
| Reusable procedure or tooling | a **skill** |
| Per-message prompt fragment | a **prompt snippet** |

## Writing a flavor

- One concern per file; keep it short.
- Lead with the posture ("You are in planning mode…").
- Express only the **delta** from the base persona; never restate it.
- Because it is appended last, it can add to or override the base.
