---
name: deep-engineering
description: Rigorous architectural design, complex refactoring, domain modeling, and root-cause debugging playbook. Trigger on "deep refactor", "architect this", "complex domain modeling", "major migration", or when structural redesign is required.
---

# Deep Engineering Playbook

A structured methodology for complex refactoring, foundational domain modeling, and deep architectural migrations.

## When to Use

- Complex features spanning multiple modules or services.
- Major codebase refactors or migrations from legacy architecture.
- Designing core data models, state machines, or boundary schemas.
- Investigating subtle bugs where symptom-silencing must be prevented.

---

## Core Principles

### `P1`: Foundational Thinking (Data Structures First)
- Before writing algorithms, procedural logic, or UI adapters, explicitly define the core data models and state shapes.
- When core data structures accurately reflect the problem, surrounding application logic becomes minimal and simple.

### `P2`: Redesign from First Principles (No Patchwork Accretion)
- When integrating a requirement that conflicts with existing architecture, do not apply a surface workaround.
- Ask: *"If this requirement existed on Day 1, how would the foundation be structured?"*
- Refactor the baseline so the new feature fits natively into the architecture.

### `P3`: Fix Root Causes (No Symptom Silencing)
- Trace every exception or failure back to the original source.
- Do not wrap failing calls in blank `try/catch` blocks or inject defensive fallback values to mask bugs.
- If a value is unexpectedly `None`, resolve why the upstream producer emitted `None`.

### `P4`: Model the Domain (State Machines over Scattered Booleans)
- Replace scattered boolean flags (`is_loading`, `is_error`, `has_retried`, `is_cancelled`) with explicit state machines, tagged unions, or enum states.
- Make illegal or conflicting domain states unrepresentable in the type system.

### `P5`: Boundary Discipline ("Parse, Don't Validate")
- Validate and parse untrusted external data (HTTP payloads, file reads, CLI arguments) strictly at system entrance boundaries into strongly-typed models.
- Core internal business functions operate on trusted types and must not repeat defensive validation or null-checks.

---

## Execution Workflow

1. **Phase 1: Domain & Boundary Audit**
   - Identify external input boundaries and declare explicit schema models.
   - Map existing state flags and consolidate them into an explicit state machine or union type.

2. **Phase 2: Foundation & Data Structures**
   - Write or refactor core entities first.
   - Verify that all illegal states are unrepresentable before writing procedural logic.

3. **Phase 3: Surgical Migration**
   - Update internal callers to consume strongly-typed models directly.
   - Delete obsolete single-caller helpers, intermediate adapters, and defensive null-checks.

4. **Phase 4: Root-Cause Verification**
   - Run end-to-end tests against real runtime outputs.
   - Verify that error paths surface actionable failure diagnostics rather than silent fallbacks.
