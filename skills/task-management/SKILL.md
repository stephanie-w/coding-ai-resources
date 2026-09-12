---
name: task-management
description: Planning and creating structured tasks, epics, and breaking down requirements into TODO.md using rich templates. Use when asked to plan or manage tasks.
applyTo: "*"
---

# Task Management Skill

This skill provides structured templates and workflows for managing development tasks with rich metadata, dependency tracking, and persistent thought process documentation. It enhances TODO.md with structured task definitions that capture context, artifacts, and decision rationale.

## When to Use This Skill

- When creating or updating major tasks and epics in TODO.md
- When breaking down requirements into actionable phases
- When tracking development progress across phases
- When documenting architectural decisions and rationale
- When maintaining persistent records of hypothesis-exploration-plan-observation-decision cycles
- When linking related tasks with parent/child relationships or dependencies
- When managing context files and artifacts for tasks

## Core Concepts

### 1. Structured Task Template
Tasks follow a consistent template (`templates/TASK_TEMPLATE.md`) with:
- **Metadata**: Status, priority, dates, ownership
- **Relationships**: Parent tasks, dependencies, blockers
- **Context**: Relevant files for implementation
- **Artifacts**: Logs, test results, screenshots
- **Thought Process**: Hypothesis, exploration, plan, observations, decisions
- **Links**: Related PRs, commits, external references

### 2. Parent/Child Relationships
- **Parent Task**: High-level topic or phase (e.g., "Phase 5: Advanced TUI Features")
- **Child Task**: Specific implementation task (e.g., "Modal Help & Settings")
- **Dependencies**: Tasks that must complete before this task can start
- **Blockers**: Tasks preventing progress on this task

### 3. Integration with TODO.md
- TODO.md remains the high-level roadmap organized by phases
- Individual tasks within phases use the structured template
- Tasks maintain backward compatibility with checkbox syntax (`[ ]`, `[x]`)

## Workflow

### 1. Creating a New Task
1. Identify the parent phase/topic in TODO.md
2. Create a new task section using the template (`templates/TASK_TEMPLATE.md`)
3. Fill in metadata (status, priority, dates)
4. Define relationships (parent, dependencies)
5. Add context files and expected artifacts
6. Document initial hypothesis and plan

### 2. Task Relationships Management
- Use `Parent` field to link to phase/section
- Use `Dependencies` to list tasks that must complete first
- Use `Blocked By` to track blockers
- Use `Related Tasks` for loosely connected tasks

## Examples

### Example 1: Modal Help & Settings Task
See `templates/EXAMPLE_TASK.md` for a complete example based on Phase 5, "Modal Help & Settings".

### Example 2: Phase Structure
```markdown
## Phase 5: Advanced TUI Features (Active)

### 🚀 Immediate Priority: UI Polish & UX

#### [ ] Modal Help & Settings
[Task template applied here...]
```

## Best Practices

1. **Keep TODO.md Organized**: Maintain phase/topic structure as parent containers
2. **Update Thought Process Continuously**: Document observations and decisions as you work
3. **Link Context Files**: Include all relevant files for the task
4. **Track Artifacts**: Reference logs, test results, screenshots
5. **Maintain Relationships**: Keep parent/dependency links current
6. **Use Consistent Statuses**: todo → in_progress → blocked → done

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Task template too verbose | Focus on essential fields; optional sections can be omitted |
| Parent reference unclear | Use explicit phase/topic names with anchors if possible |
| Artifacts not yet created | Use placeholder paths; update when artifacts exist |
| Too many dependencies | Break down task into smaller subtasks |

## References

- See `templates/TASK_TEMPLATE.md` for the complete template
- See `references/INTEGRATION_GUIDE.md` for TODO.md integration details
- See `templates/EXAMPLE_TASK.md` for a working example
