# Subagent Orchestration Template

Use this template prompt to delegate non-trivial features, bug fixes, or integrations across the specialized subagent lifecycle:

```text
Orchestrate the following task:
<INSERT TASK DESCRIPTION OR TODO REFERENCE>

Follow the standard subagent lifecycle:
1. `spec_digger` (or `researcher`): Verify upstream API declarations, event lifecycles, and flags in installed packages or docs to establish ground truth.
2. `scout`: Map target files, entry points, data flow, and blast radius into a structured handoff brief.
3. `oracle`: Validate the plan against ground truth, challenge assumptions, and check for simpler lateral alternatives (hard-block if spec is flawed).
4. `worker`: Execute surgical code changes based on the approved plan and run verification tests.
5. `reviewer`: Audit the diff for regressions, edge cases, and boundary conditions.
6. `git_commit`: Author a conventional commit once verified.
```
