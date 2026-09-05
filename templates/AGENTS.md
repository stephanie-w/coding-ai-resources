# Agent Operating Protocol

You are operating in a token-optimized environment managed by `justfile.agent`.
Never run raw, unconstrained commands (`cat`, raw `pytest`, raw `grep`, `find .`).
Follow the 3-phase execution protocol below.

---

## 1. Investigation Phase (Discovering & Reading)

* **Repository Layout**: `just -f justfile.agent tree` (never run `find .` or `ls -R`).
* **Finding Files**: `just -f justfile.agent find-files "<pattern>"`.
* **Searching Code**: `just -f justfile.agent search "<term>"`.
* **Reading Files**: 
  - Never dump full files with raw `cat` or `nl`.
  - Always read numbered slices with safety caps:
    ```bash
    just -f justfile.agent view <filepath> <start_line> <end_line>
    ```

---

## 2. Modification & Verification Phase (Editing & QA)

When making code changes:
1. Apply targeted edits.
2. Run the single-turn verification QA gate:
   ```bash
   just -f justfile.agent check
   ```
   *(Runs Ruff linter, ty typechecker, and pytest with token-filtered failure reporting).*
3. For individual test verification:
   ```bash
   just -f justfile.agent test "<test_filter>"
   ```
4. For auto-fixing lint/formatting issues:
   ```bash
   just -f justfile.agent fix
   ```

---

## 3. Review & Safety Boundaries

* Before claiming completion, review changes with:
  - `just -f justfile.agent git-summary` (check dirty files)
  - `just -f justfile.agent git-diff` (review diff excluding lockfiles)
* **Hard Boundary**: Never create commits or push code automatically. Leave changes in working directory for human review.

---

## Discovery

To view all available recipes and descriptions:
```bash
just -f justfile.agent --list
```

---

## Agent Operating Guidelines (working contract with the human)

### Command hygiene

- **One command = one intent.** Do not bundle unrelated side effects into a single
  command line. A `write` and an execute belong in separate steps unless the execute is
  a direct, trivially-reviewable check of what was just written.
- **Keep the line short enough to review.** Avoid long `&&` chains, inline scripts, and
  multi-purpose `;` runs. If a step reads as "too much is going on," split it.
- **Separate build from run.** Create/write artifacts in one step; execute or verify in a
  later step. Do not create on one turn and secretly execute in the same typing.
- **Prefer declarative steps.** Let the human run heavy or state-changing commands
  (real model runs, tests, anything that writes to session history) unless asked to
  execute.

### Division of responsibility while implementing

- **I build, you test.** During early implementation, the agent produces isolated,
  reviewable artifacts; the human drives execution, `just` recipes, and model runs, and
  reports results back.
- When a step is meant for the human to run, say so explicitly and name the exact
  command, rather than running it silently.

### Reviewability

- Every change should be independently verifiable: a plain command the human can run to
  see what the file/state is, before anything that mutates state.
- Do not claim an end-to-end result you did not observe; flag unvalidated assumptions
  (e.g. "confirmed layout" vs. "assumed layout") honestly.

