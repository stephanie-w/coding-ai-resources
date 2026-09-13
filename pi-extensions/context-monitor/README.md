# context-monitor (pi extension)

Token and context budget indicator for the [pi coding agent](https://pi.dev).

Shows where your context window is going: a live footer badge, exact session
token/cost totals, and an estimated breakdown of what's filling the window.

## Features

- **Footer badge** — `ctx: 32k/128k 25%`, color-coded by fill percentage.
- **`/tokens`** — window usage, exact token/cost totals for the current branch,
  and an estimated composition (system prompt + largest entries) of what's in
  the window.
- **Cache efficiency** — cache read hit ratio and cache write volume, surfaced
  in `/tokens`.
- **Overflow surfacing** — when a turn fails on context overflow, a visible
  `⚠ overflow · compacting` state replaces the badge until compaction completes.

## Commands

| Command | Behavior |
|---|---|
| `/tokens` | Show the full context report |

## Flags

| Flag | Default | Description |
|---|---|---|
| `--context-warn-pct` | `60` | Badge turns yellow at this fill percentage |
| `--context-danger-pct` | `85` | Badge turns red at this fill percentage |

## Exact vs estimated

- **Session totals** (input/output/cache/cost) are exact: they sum `usage` from
  assistant messages, nested tool LLM work, and compaction/branch summaries.
- **Window composition** (system prompt + per-entry sizes) is estimated at
  ~4 characters per token, because pi exposes aggregate context tokens but not
  per-component counts. Image tokens are undercounted (they scale with pixel
  dimensions, not character count).

## Install

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/index.ts" ~/.pi/agent/extensions/context-monitor.ts
# or install the directory as a pi package:
pi install /absolute/path/to/pi-extensions/context-monitor
```

Then run `/reload` in pi.

## Caveats

- The badge joins pi's shared footer status line. Text is kept short because
  truncation chops the right side.
- Right after compaction, pi reports context tokens as `null`; the badge shows
  the last known value with a `~` marker until the next response lands.
- `getContextUsage()` uses the last assistant usage and estimates trailing
  messages, so the badge figure is a good-faith estimate, not an exact count.
