# Ask User Question

This extension comes from upstream:

**→ [amosblomqvist/pi-config (extensions/ask-user-question.ts)](https://github.com/amosblomqvist/pi-config/blob/main/extensions/ask-user-question.ts)**

Interactive multiple-choice and freeform text input tool for Pi TUI (`ask_user_question`). Allows the agent to pause execution and solicit user clarifications, select options with keyboard navigation, or collect custom written inputs directly in the terminal interface.

---

## Installation

### Direct download to global extensions

```bash
mkdir -p ~/.pi/agent/extensions
curl -fLo ~/.pi/agent/extensions/ask-user-question.ts \
  https://raw.githubusercontent.com/amosblomqvist/pi-config/main/extensions/ask-user-question.ts
```

Then reload Pi:
```text
/reload
```
