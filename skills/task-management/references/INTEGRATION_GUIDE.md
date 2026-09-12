# TODO.md Integration Guide

This guide explains how to integrate structured task templates with the existing TODO.md file while maintaining backward compatibility and organization.

## Current TODO.md Structure

The TODO.md is organized hierarchically:
```
# acp-client TODO
## Phase X: Topic (Status)
### 🚀 Priority Category
- [ ] **Task Title**:
    - Subtask details
    - More details
```

## Integration Approach

### 1. Preserve Existing Structure
- Keep phases, priority categories, and checkbox syntax
- Enhance individual tasks with structured templates
- Maintain readability for both humans and agents

### 2. Template Application
Apply the task template **within** the existing checklist items:

```markdown
### 🚀 Immediate Priority: UI Polish & UX
- [ ] **Modal Help & Settings**:
    
    #### Metadata
    - **Status**: todo
    - **Priority**: high
    - **Created**: 2026-03-14
    - **Updated**: 2026-03-14
    
    #### Goal
    Implement modal screens for Help and Settings...
    
    [Rest of template...]
```

### 3. Relationship Mapping
- **Parent**: Use the phase and priority category as parent reference
- **Dependencies**: Reference other tasks in the same TODO.md using task titles
- **Blocked By**: Track blockers within the same document

### 4. Status Synchronization
- Checkbox `[ ]`/`[x]` should match **Status** field
- When status changes to `done`, update checkbox to `[x]`
- When checkbox is toggled, update status field accordingly

## Migration Steps for Existing Tasks

### Step 1: Identify Task to Enhance
Choose a task from TODO.md that needs detailed tracking (e.g., "Modal Help & Settings").

### Step 2: Create Template Instance
Copy `TASK_TEMPLATE.md` and adapt it for the specific task.

### Step 3: Insert into TODO.md
Replace the simple checklist item with the enhanced template:

**Before:**
```markdown
- [ ] **Modal Help & Settings**:
    - Implement `HelpScreen(ModalScreen)` to show commands without cluttering history.
    - Implement `SettingsScreen(ModalScreen)` for viewing/editing client configuration.
```

**After:**
```markdown
- [ ] **Modal Help & Settings**:
    
    #### Metadata
    - **Status**: todo
    - **Priority**: high
    - **Created**: 2026-03-14
    - **Updated**: 2026-03-14
    
    #### Relationships
    - **Parent**: Phase 5: Advanced TUI Features → 🚀 Immediate Priority: UI Polish & UX
    
    #### Goal
    Implement modal screens for Help and Settings...
    
    [Rest of template...]
```

### Step 4: Update As Work Progresses
- Modify status from `todo` → `in_progress` → `done`
- Add observations and decisions during implementation
- Link actual artifacts (logs, test results)
- Update dependencies and blockers

## Best Practices

### 1. Balance Detail vs. Readability
- Use full template for complex, high-priority tasks
- Use simplified version for straightforward tasks
- Consider creating separate task files for very complex tasks

### 2. Maintain Backward Compatibility
- Always keep the checkbox syntax
- Ensure tasks remain readable without parsing the template
- Use indentation consistently (4 spaces for nested content)

### 3. Link Between Tasks
- Use task titles as anchors when referencing other tasks
- For phases, use the exact heading text (e.g., `Phase 5: Advanced TUI Features`)
- Consider adding actual Markdown anchors if needed

### 4. Version Control
- Commit template updates separately from task content
- Use descriptive commit messages when updating task status
- Consider task state as part of project documentation

## Example: Complete Integrated Section

```markdown
## Phase 5: Advanced TUI Features (Active)

### 🚀 Immediate Priority: UI Polish & UX

- [x] **Prompt History**:
    - Implement Up/Down arrow navigation for previous commands.

- [ ] **Modal Help & Settings**:
    
    #### Metadata
    - **Status**: todo
    - **Priority**: high
    - **Created**: 2026-03-14
    - **Updated**: 2026-03-14
    
    #### Relationships
    - **Parent**: Phase 5: Advanced TUI Features → 🚀 Immediate Priority: UI Polish & UX
    - **Dependencies**: [Prompt History](#)
    
    #### Goal
    Implement modal screens for Help and Settings...
    
    [Rest of template...]

- [ ] **System Notifications**:
    - Migrate "Agent Ready" and "Mode Switched" messages to `self.notify()`.
```

## Tools and Automation

Consider creating scripts to:
1. Validate template compliance
2. Sync checkbox status with metadata status
3. Generate task reports from TODO.md
4. Extract tasks into separate files for complex projects

## See Also
- `TASK_TEMPLATE.md` - Complete task template
- `EXAMPLE_TASK.md` - Working example
- `SKILL.md` - Main skill documentation
