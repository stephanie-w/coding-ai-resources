---
description: "Rules for maintaining rich task lifecycle management and thought process tracking in TODO.md."
applyTo: "*"
---
## Task Tracking (Full)

This document defines the continuous rules for task tracking during production development.

> **Note:** For creating new tasks, planning epics, or breaking down requirements, invoke the `task-management` skill to use the full structured templates and integration guides.

### 📋 Core Tracking Rules

1. **Stateful Planning**: Before writing code, update the task's hypothesis and plan in `TODO.md`.
2. **Persistent Thought Process**: Continuously document your observations and decisions as you work. This serves as an audit trail.
3. **Artifact Traceability**: Link relevant files, logs, and artifacts directly in the task section of `TODO.md`.
4. **Consistent Statuses**: Always keep the task status updated (`todo` → `in_progress` → `blocked` → `done`).
5. **Marking Complete**: When a task is finished, set its status to `done`, record the completion date, and ensure all decisions are captured before moving on.

### 📝 Task Structure (Summary)

Tasks in `TODO.md` must maintain the following sections:
- **Metadata**: Status, Priority, Dates
- **Relationships**: Parent phase, Dependencies, Blockers
- **Thought Process**: Hypothesis, Exploration, Plan, Observations, Decisions

*Do not rely on your short-term memory. Write your findings down in the `TODO.md` task.*
