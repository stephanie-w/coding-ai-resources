# coding-ai-resources — Agent Notes

Canonical catalog of agent primitives (persona, flavors, skills, extensions) plus
the `just` automation that installs them. Pi-first.

## Task runner: `just`

This repository is driven by `just`. Prefer recipes over raw equivalents, and
discover what exists before improvising.

```bash
just --list                    # discover all recipes
just --dry-run <recipe> ...    # preview a recipe without executing it
JUST_UNSTABLE=1 just --fmt     # format the justfile (formatter is unstable)
```

| Recipe | Purpose |
| :--- | :--- |
| `just pi [flavor...] [args]` | Launch Pi: base persona + zero or more flavor overlays |
| `just link-persona` | One-time: link `agents/base.agent.md` to `~/.pi/agent/AGENTS.md` |
| `just link-extensions [ext]` | Link one or all `pi-extensions/` into `~/.pi/agent/extensions/` |
| `just install-global [pack]` | Install a Pi package globally (`packages/<pack>`) |
| `just setup-python <target>` | Scaffold a project with `justfile.agent` + `AGENTS.md` |
| `just test-pack [pack]` | Run Pi with this repository's skills loaded |
| `just reflect [timespan]` | Mine session corrections to evolve the rules |
| `just validate` | Validate all `package.json` manifests |

After editing the justfile, run `JUST_UNSTABLE=1 just --fmt`; do not hand-tune the
`{{ x }}` spacing.

## Layout

- `agents/` — personas; `base.agent.md` is installed globally via `just link-persona`
- `flavors/` — session overlays for `just pi` (`rapid`, `full`, `python`, `plan`)
- `skills/` — reusable procedures (Agent Skills standard)
- `instructions/` — harness-agnostic policies for Copilot-style agents (`.instructions.md` + `applyTo`); **not loaded by Pi**
- `pi-extensions/` — TypeScript extensions for Pi
- `packages/` — Pi package manifests
- `templates/` — files copied into target projects
- `docs/pi-harness.md` — persona/flavor model, prompt sources, scenarios

## Conventions

- **Pi-first for new work.** Copilot is still in use, so the harness-agnostic
  `instructions/` stay. Prefer Pi-native primitives (persona, flavors, skills,
  prompt templates, extensions) for anything new.
- `applyTo` frontmatter is honored by Copilot but **ignored by Pi** — keep those
  rules portable, or mirror them as a flavor (see `flavors/full.md`, `flavors/python.md`).
- Keep the directory tree in `README.md` in sync when adding top-level items.
