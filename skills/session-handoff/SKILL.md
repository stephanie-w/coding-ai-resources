---
name: session-handoff
description: Save and restore development state across session boundaries. Trigger on "checkpoint", "wrap up", "save handoff", "resume", "load handoff", or "/handoff".
---

# Session Handoff & Checkpointing

Manages point-in-time snapshots of working context so work can be resumed seamlessly in a future session.

---

## 1. Snapshot Protocol (Wrap Up)

**Trigger phrases:** `"checkpoint"`, `"wrap up"`, `"save handoff"`, `"/handoff"`

1. Inspect current branch and commit SHA (`git rev-parse --short HEAD`).
2. Read `TODO.md` to identify the active subtask and any blockers.
3. Record the last verification command and its result.
4. Write `HANDOFF.md` to the project root with the following structure:

```markdown
# Session Handoff

- **Date / Timestamp:** YYYY-MM-DDTHH:MM:SS
- **Git Branch & Commit:** `<branch>` (`<sha>`)
- **Active Task:** <Current subtask from TODO.md>
- **Last Verification:** `<command>` -> <Result/Status>
- **Blockers / Open Questions:** <Any open items>
- **Immediate Next Step on Resume:** <The single concrete command or file edit to perform first>
```

---

## 2. Resume Protocol (Restore State)

**Trigger phrases:** `"resume"`, `"load handoff"`, `"continue work"`

1. Read `HANDOFF.md` from the project root.
2. Verify git status matches the recorded branch and commit.
3. Output a concise 2-line status summary and propose the recorded *Immediate Next Step*.
4. Prompt user confirmation before removing `HANDOFF.md`.
