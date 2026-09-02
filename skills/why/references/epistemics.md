# Epistemics and Confidence Calibration

Investigating historical code intent requires strict epistemics. Code tells you what it does, not why it exists. This document defines the confidence calibration and evidence rules for the `why` skill.

---

## 1. Evidence Levels

| Level | Evidence Required | Permitted Language |
| :--- | :--- | :--- |
| **High** | Direct, explicit statement in commit message, PR description, ADR, or design doc by author. | *"Introduced in commit `abc1234` to resolve ticket #42..."* |
| **Medium** | Clear inference from surrounding diff, failing regression test, or linked issue title. | *"The diff in PR #12 indicates this was added to prevent race conditions during..."* |
| **Low / Hypothesis** | Plausible structural hypothesis with no direct commit or documentation record. | *"Appears to serve as a guard against... (Note: No explicit commit justification found)."* |

---

## 2. Core Rules

1. **Cite Everything:** Every factual claim must cite a commit SHA (`abc1234`), PR number (`#123`), file path, or ADR link.
2. **Never Retrofit Intent:** Do not assume ugly or unusual code was carefully planned. Code is often a rush job or temporary workaround.
3. **Surface Gaps:** If git history dead-ends (e.g. initial massive commit `Initial commit`), explicitly state that the origin rationale is unrecorded.
4. **Hedge Indirect Claims:** Use *"likely"*, *"appears to"*, and *"suggests"* when drawing conclusions from diff shape rather than written explanations.
