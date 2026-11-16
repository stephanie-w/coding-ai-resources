---
name: improve-codebase-architecture
description: 'Scan a Python, backend, or ML codebase for deepening opportunities, present them as a visual HTML report, and grill through whichever candidate the user picks. Use when asked to review architecture, find refactoring or deepening opportunities, reduce module shallowness, or untangle Python/backend/ML pipelines.'
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities**: refactors that turn shallow modules into deep ones. The aim is testability, locality, and AI-navigability—adapted for Python apps, backends, and ML codebases.

## Design Vocabulary (Use Consistently)

Use these terms exactly in every candidate and diagram; do not drift into "component," "service," "API," or "boundary":

- **module**: a cohesive unit (file, package, or class) behind an interface.
- **interface**: what callers and tests must know to use the module (signatures, typed models, tensor/DataFrame contracts, raised errors).
- **implementation**: the internal logic hidden behind the interface.
- **depth** (**deep** / **shallow**): deep = small interface hiding substantial complexity; shallow = interface nearly as complex as the implementation.
- **seam**: a replaceable boundary where an adapter can be plugged in.
- **adapter**: an implementation behind a seam (`in-process`, `local-substitutable`, `ports & adapters`, or `mock`).
- **leverage**: one interface serving many call sites or absorbing scattered logic.
- **locality**: keeping related behavior together so understanding or changing one concept does not require bouncing across files.

Core rules:
- **Deletion test**: would deleting this module/wrapper concentrate complexity, or just move it? "Concentrates" (or removes pass-through noise) is the signal to collapse it.
- **The interface is the test surface**: test through the deepened module's interface, not private helpers or mocked internals.
- **One adapter = hypothetical seam, two = real**: do not keep a `Protocol`/`ABC` seam for a single production implementation unless a real second adapter (e.g., in-memory/SQLite fake in tests, or local vs. cloud store) earns it.

If `GLOSSARY.md` exists, use its domain names for modules; if `docs/adr/` exists, respect existing ADRs unless friction warrants revisiting one.

---

## Process

### 1. Explore

**Scope before you scan (YAGNI).** Deepening pays off where the code is actively changing:
- If the user named a subsystem, module, or pain point, focus there.
- Otherwise, inspect `git log --oneline -n 50` (or `git log --stat`) to locate hot spots—files and packages that keep changing together.

Read `AGENTS.md`, `GLOSSARY.md` (if present), and relevant files in `docs/adr/` (if present).

Delegate a fresh-context exploration (using a read-only subagent such as `py_explore` or `explore` when available) to walk the target area and note friction:

**General & Python/Backend signals:**
- Understanding one concept requires bouncing between many tiny modules (`utils.py`, `helpers.py`, single-caller wrappers).
- **Over-layered CRUD**: `Router → Service → Repository → Mapper` pass-throughs where middle modules fail the deletion test.
- **Hypothetical seams**: single-implementation `Protocol`/`ABC` classes or dependency-injection boilerplate with only one real adapter.
- **Leaky seams**: DB sessions, transactions, HTTP request objects, or raw dicts leaking across layers instead of parsing at the boundary (e.g., Pydantic) into a pure `core/` module.
- **Test-induced fragmentation**: pure functions extracted solely for unit testing while real bugs hide in how they are wired together.

**ML & Data Pipeline signals:**
- **Training–serving skew**: preprocessing, feature transforms, tokenization, or post-processing duplicated across training scripts, evaluation, and inference handlers instead of one deep transform module.
- **Config plumbing**: untyped `dict` / `argparse` / Hydra configs threaded through 5+ functions instead of a typed config boundary.
- **Tensor / DataFrame contract leakage**: raw `torch.Tensor`, `np.ndarray`, or `pd.DataFrame` crossing seams without shape/dtype/schema guarantees, forcing defensive checks everywhere.
- **Mock-heavy ML tests**: tests mocking `torch`, `sklearn`, or `DataLoader` instead of isolating pure transform/math logic from dataset, checkpoint, and device I/O so tests run fast on small synthetic tensors/DataFrames.
- **Implicit global state**: scattered RNG seeding or hardcoded `cuda`/`cpu` device assumptions.

### 2. Present Candidates as an HTML Report

Write a self-contained HTML report to the OS temp directory (never into the repository):
- Resolve `$TMPDIR`, falling back to `/tmp` (or `%TEMP%` on Windows), and write `<tmpdir>/architecture-review-<timestamp>.html`.
- Open it for the user (`xdg-open <path>` on Linux, `open <path>` on macOS, `start <path>` on Windows) and state the exact absolute path.

See [references/html-report.md](references/html-report.md) for the HTML scaffold, Tailwind/Mermaid setup, diagram patterns, and tone rules.

For each candidate card include:
- **Files**: repo-relative paths involved
- **Problem**: one sentence on the friction
- **Solution**: one sentence on what collapses or deepens
- **Benefits**: concise bullets in terms of **locality**, **leverage**, and improved **tests**
- **Before / After diagram**: custom-drawn side-by-side visual
- **Recommendation strength**: `Strong`, `Worth exploring`, or `Speculative` + dependency tag (`in-process`, `local-substitutable`, `ports & adapters`, `mock`)
- **ADR callout** (only if a real conflict is worth reopening)

End with a **Top recommendation** section. Do **not** propose detailed code interfaces yet. After writing the report, ask:

> "Which of these would you like to explore?"

### 3. Grilling Loop

Once the user picks a candidate, walk the decision tree interactively (one focused question at a time):
1. **Constraints & invariants**: what must remain true (public contracts, latency/memory/device constraints, transaction boundaries, training/serving parity)?
2. **Shape of the deepened module**: what stays inside the implementation vs. what belongs on the interface? (If multiple interface shapes look plausible, sketch 2–3 distinct options side by side—"design it twice"—and compare trade-offs.)
3. **Behind the seam**: which dependencies are `in-process` (keep concrete), `local-substitutable` (e.g., SQLite/tmp_path/synthetic tensor), or `ports & adapters` (real second adapter)?
4. **Surviving tests**: which new interface-level tests replace fragmented unit tests or mock-heavy tests?

Keep project artifacts current inline as decisions settle:
- If `GLOSSARY.md` exists (or the user wants one) and a new domain concept is named or sharpened, update it.
- If the user rejects a candidate for a **load-bearing architectural reason** (not just "not now"), offer: *"Want me to record this as an ADR in `docs/adr/` so future reviews don't re-suggest it?"*
