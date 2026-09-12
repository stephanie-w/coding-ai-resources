# Flavors

Session-scoped overlays appended to `agents/base.agent.md`. A flavor tunes how
the base persona operates for **one session** — it is not a persona and not a
reusable procedure.

A flavor is a plain markdown file named `<name>.md`. Launch one or more with:

```bash
just pi <name>... [pi args...]
```

- `just pi` → base persona only.
- `just pi plan` → base persona + `flavors/plan.md`.
- `just pi rapid python` → base persona + both overlays, in order (later overrides earlier).
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

## Compatibility

A flavor can declare an incompatibility with an HTML comment:

```markdown
<!-- incompatible: full -->
```

`just pi` rejects any selection that includes both sides. Currently:

- **`rapid` ✗ `full`** — opposite ends of the ceremony axis (minimal updates vs
  rich, continuous tracking). Pick one.

`python` and `plan` compose with either.

## Relationship to `instructions/`

`instructions/*.instructions.md` are harness-agnostic policies for Copilot-style
agents (they honor `applyTo`). **Pi does not read them.** Some Pi flavors cover
the same ground so the rules are available here too:

| Flavor | Overlaps with |
| :--- | :--- |
| `full.md` | `instructions/task-tracking-full.instructions.md` |
| `python.md` | `instructions/python-dev.instructions.md` (expanded with typing/security) |

They are not redundant: Copilot applies its instructions automatically, while a
Pi flavor is opt-in per session. But they can drift — when you change one, update
its counterpart.

## What belongs where

| Concern | Home |
| :--- | :--- |
| Session posture / mode | a **flavor** (this directory) |
| Always-on project rules | `AGENTS.md` (see `templates/AGENTS.md`) |
| Reusable procedure or tooling | a **skill** |
| Per-message prompt fragment | a **prompt snippet** |
| Copilot-style policy (`applyTo`) | `instructions/` — **not loaded by Pi** |

## Writing a flavor

- One concern per file; keep it short.
- Lead with the posture ("You are in planning mode…").
- Express only the **delta** from the base persona; never restate it.
- Because it is appended last, it can add to or override the base.
