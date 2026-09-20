# BTW (Sidecar Sub-Session Channel)

This extension comes from upstream:

**→ [dbachelder/pi-btw](https://github.com/dbachelder/pi-btw)**

Adds a parallel `/btw` side-conversation channel to Pi. Opens a full-featured sub-session with coding-tool access (`read`, `bash`, `edit`, `write`) in a dedicated modal overlay, running concurrently even while the main agent is actively busy.

---

## Key Capabilities

- **Non-blocking parallel execution:** Ask side questions or initiate sub-tasks without interrupting or waiting for the main agent run.
- **Dedicated TUI modal overlay:** Built-in composer and streaming transcript with window/borderless layout toggling (`Alt+w` for clean mouse drag selection).
- **Context isolation:** Thread history remains hidden from the main session context to prevent token bloat and cache churn.
- **Context handoffs:** Bridge answers back into the main conversation at will with `/btw:inject` or `/btw:summarize`.
- **Thread branching & tangents:** Continuous side thread by default, or `/btw:tangent` for fresh contextless exploration.
- **Model & thinking overrides:** Independent model and reasoning effort settings via `/btw:model` and `/btw:thinking`.

---

## Commands

| Command | Description |
| :--- | :--- |
| `/btw <question>` | Open/continue the BTW side-session thread |
| `/btw --save <question>` | Run inline and persist the exchange as a visible session note |
| `/btw:new <topic>` | Start a fresh BTW thread |
| `/btw:tangent <question>` | Ask without inheriting the current main-session context |
| `/btw:inject [instruction]` | Inject the BTW discussion directly into the main agent |
| `/btw:summarize` | Summarize the side thread into a handoff note for the main session |
| `/btw:model <provider> <model>` | Set a custom model for BTW sub-sessions |
| `/btw:thinking <level>` | Set thinking budget (e.g. `low`, `high`) for BTW |
| `/btw:clear` | Reset the active BTW thread |

---

## Overlay & Keybindings

- **`Alt+w`** : Toggle overlay between inset framed box and edge-to-edge layout (avoids border characters during mouse drag selection).
- **`Alt+/` / `Super+/` / `Ctrl+Alt+W`** : Toggle focus between the BTW modal and main editor without closing the overlay.
- **`PI_BTW_FOCUS_KEYS`** : Environment variable to remap focus shortcuts if conflicting with WM keybindings (e.g., `PI_BTW_FOCUS_KEYS="ctrl+/"`).

---

## Installation

### Global install from Git (recommended)

```bash
pi install git:github.com/dbachelder/pi-btw
```

### Global install from npm (when published)

```bash
pi install npm:pi-btw
```

### Local vendor checkout

```bash
# 1. Clone into the catalog folder
git clone https://github.com/dbachelder/pi-btw pi-extensions/btw

# 2. Install dependencies
cd pi-extensions/btw && npm install

# 3. Link or install (just link-extensions also runs npm install automatically)
just link-extensions btw
# or: pi install "$PWD/pi-extensions/btw"
```

Reload Pi after installing:
```text
/reload
```
