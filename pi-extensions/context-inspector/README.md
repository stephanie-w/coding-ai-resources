# Context Inspector

This extension comes from upstream:

**→ [diegopetrucci/pi-extensions (extensions/context-inspector)](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/context-inspector)**

Provides `/context`, generating a local HTML dashboard in your browser that visually dissects token distribution across your active Pi session (system prompts, tool schemas, user messages, assistant thinking, tool outputs, and compaction summaries).

---

## Key Features

- **Visual Token Breakdown:** Donut and stacked bar visualizations for session token allocation.
- **Granular Component Attribution:** Breaks down cost between system prompts, tool schemas, user messages, assistant thinking, tool outputs, and compaction summaries.
- **Segment Drilldown:** Search by content, tool name, file path, command, and category.
- **Branch Comparison:** Compare current model context against full active branch history.
- **Privacy & Offline:** Standalone local HTML file created with private permissions; zero network calls.

---

## Commands

| Command | Description |
| :--- | :--- |
| `/context` | Generate and open the context distribution dashboard in your default browser |
| `/context --no-open` | Generate the HTML report without opening the browser |
| `/context --keep` | Persist report under `<config-dir>/context-reports/` instead of OS temp dir |
| `/context --redact` | Hide message text, tool contents, and paths while retaining token metrics |
| `/context --full` | Open report directly on the full active branch history tab |

---

## Installation

### From npm (recommended)

```bash
pi install npm:@diegopetrucci/pi-context-inspector
```

### From Git repository

```bash
pi install git:github.com/diegopetrucci/pi-extensions
```

Reload Pi after installing:
```text
/reload
```
