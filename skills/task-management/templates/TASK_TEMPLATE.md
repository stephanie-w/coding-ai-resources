# Task Template

Use this template for creating structured tasks with metadata, relationships, and thought process tracking.

## [ ] Task Title

### Metadata
- **Status**: todo/in_progress/blocked/done
- **Priority**: high/medium/low
- **Created**: YYYY-MM-DD
- **Updated**: YYYY-MM-DD
- **Owner**: @username (optional)

### Relationships
- **Parent**: [Parent Task Name](#) or Phase X: Topic
- **Dependencies**: [Task Name](#), [Another Task](#)
- **Blocked By**: [Blocking Task](#)
- **Related Tasks**: [Related Task](#)

### Goal
Brief description of what needs to be accomplished

### Context Files
`src/file.py`, `docs/...` (files relevant to this task)

### Artifacts
- Logs: `logs/task-name.log`
- Test Results: `test-results/...`
- Screenshots: `screenshots/...`

### Thought Process
#### Hypothesis
Initial assumptions and expected outcomes

#### Exploration  
Research findings, code analysis, external references

#### Plan
Step-by-step implementation approach

#### Observations
What happened during implementation (actual vs expected)

#### Decisions
Key architectural choices and rationale

### Links
- Related PRs: #123
- Commits: abc123def
- External References: [URL](https://...)

---

## Usage Notes

1. **Copy this template** when creating a new task
2. **Replace placeholders** with actual content
3. **Update status** as work progresses
4. **Fill thought process** during implementation
5. **Link artifacts** when they become available
6. **Maintain relationships** with parent/dependent tasks

## Field Explanations

| Field | Purpose | Required |
|-------|---------|----------|
| **Status** | Current progress state | Yes |
| **Priority** | Importance for scheduling | Yes |
| **Parent** | High-level phase/topic container | Recommended |
| **Dependencies** | Tasks that must complete first | Optional |
| **Context Files** | Files to read/analyze for task | Recommended |
| **Artifacts** | Outputs to create/verify | Optional |
| **Thought Process** | Documentation of reasoning | Recommended |

## Status Flow
```
todo → in_progress → (blocked) → done
```

Update the **Updated** field whenever any change is made.
