---
description: "Simple checklist-style task tracking rules for rapid development workflows."
applyTo: "*"
---
## Task Tracking (Basic)

This document defines the **simple task tracking workflow** for MVP and rapid development modes.

### 📋 Core Tracking Rules

1. **Checklist Format**: Use simple `- [ ]` checkboxes in `TODO.md` under the appropriate feature or bug heading.
2. **Status Updates**: Update the checkbox to `- [x]` immediately upon completing a task.
3. **Concise Descriptions**: Keep task descriptions short and actionable.
4. **Brief Notes**: Add brief sub-bullets for critical notes if helpful, but avoid extensive documentation.

### 📝 Example TODO.md

```markdown
## Project TODO

### Feature: User Authentication

- [ ] Implement login endpoint
- [ ] Add password hashing
- [ ] Create session management
- [ ] Write basic tests

### Bug Fixes

- [x] Fix null pointer in user service
```
