---
name: why
description: Forensic investigation into code motivation, historical intent, design trade-offs, and regression context. Use when asking "why was this built this way", "why did we pick X over Y", or investigating Chesterton's Fence before refactoring.
---

# Code Motivation & Intent Forensics (`why`)

Investigates the history, trade-offs, and constraints behind existing code. Companion to the `how` skill (`how` explains runtime mechanics; `why` uncovers historical motivation).

---

## Operating Posture

- **Evidence before narrative:** Collect commit citations, PR notes, and ADR references before forming conclusions.
- **Precision over polish:** Directly cite commit hashes (`git log -S`), PR numbers, or documentation lines.
- **No retrofitting intent:** If a workaround has no commit notes, state that the origin rationale is unrecorded rather than inventing a rationale.
- **Follow epistemic rules:** Read [references/epistemics.md](references/epistemics.md) for confidence calibration and permitted phrasing.

---

## 3-Step Forensic Procedure

### 1. Locate the Origin Commit
Use local Git tools to pinpoint when the line, function, or pattern was introduced:
```bash
# Find commits modifying the specific pattern
git log -S "<pattern>" -p -n 5

# Trace line range evolution
git log -L <start>,<end>:<file>
```

### 2. Extract Intent from Metadata & PRs
Inspect the full commit message and linked pull request:
```bash
git show <commit-sha> --stat
# If GitHub CLI is available and PR # is mentioned:
gh pr view <pr-number> --json title,body
```

### 3. Check In-Repo ADRs and Documentation
Search `docs/`, `architecture/`, and module docstrings for recorded architectural decisions or constraint definitions.

---

## Output Standard

Deliver findings concisely:
1. **Direct Answer:** The core constraint, bugfix, or trade-off that motivated the code.
2. **Cited Evidence:** Exact commit SHA (`abc1234`), author date, commit title/body quote, or PR number.
3. **Confidence Level:** High (explicit author statement), Medium (clear inference from diff), or Low/Hypothesis (unrecorded).
4. **Actionable Takeaway:** Is this constraint still active, or safe to refactor/delete?
