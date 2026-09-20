# notify-i3

Desktop and terminal notifications for Pi. Notifies when a task finishes or when
Pi blocks waiting for your input.

## Behavior

- `agent_settled` -> "Task finished in ..." notification, only when the task ran
  at least `thresholdMs` (default 5s).
- `ui_prompt_start` -> "Waiting for your input" notification, immediately.
- Subagents (`PI_SUBAGENT_DEPTH >= 1`) never notify.

Notifications are debounced (2s window) so bursts of settle/prompt events do not
spam the notification daemon, and a "finished" notification is suppressed within
5s of a "waiting for input" notification.

## Transport selection

Resolution happens on first use. `notify-send` is preferred; a failure demotes to
the next option for the rest of the session.

1. `notify-send` (libnotify) when `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, or
   `WAYLAND_DISPLAY` is set.
2. Kitty OSC 99 when `KITTY_WINDOW_ID` is set.
3. OSC 777 (Ghostty, iTerm2, WezTerm, rxvt-unicode) when stdout is a TTY.

On i3 with a notification daemon (e.g. Dunst), the desktop path is used.

## `/notify` command

| Command | Effect |
| --- | --- |
| `/notify` or `/notify status` | Show enabled state, transport, and threshold |
| `/notify on` / `/notify off` | Enable or disable notifications |
| `/notify toggle` | Flip the enabled state |
| `/notify test` | Send a test notification now |
| `/notify threshold <value>` | Set the task-finished threshold, e.g. `5s`, `2m`, `10000` |

## Configuration

State persists to `<agent-dir>/notify-i3.json` (default
`~/.pi/agent/notify-i3.json`):

```json
{
  "enabled": true,
  "thresholdMs": 5000,
  "transport": "auto"
}
```

- `enabled`: master toggle.
- `thresholdMs`: minimum task duration (ms) before a "finished" notification.
- `transport`: `auto` (default), `desktop` (notify-send only), `osc` (terminal
  escape only), or `off`.

## Install

```bash
just link-extensions notify-i3
```

Requirements: `notify-send` from `libnotify` (present on most distros), or a
terminal supporting OSC 99 / OSC 777 for the fallback path.
