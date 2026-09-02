---
name: discover-standards
description: User-guided extraction of tribal knowledge and implicit codebase conventions into documented project standards. Triggers on "discover standards", "document standard", "extract pattern", or topic-specific requests like "document our error handling".
---

# Discover Standards (User-Guided & Local-First)

Extracts tribal knowledge and implicit codebase conventions into compact, project-local instruction files so future agent sessions and team members adhere to them automatically.

---

## Operating Principles

1. **User-Guided Focus:** The user initiates with a specific topic or architectural area (e.g. error handling, database sessions, test fixtures, data caching). If no topic is provided, ask the user which domain they want to formalize.
2. **Tooling Discipline:** Use `justfile.agent` inspection recipes (`search`, `find-files`, `view`) or fast CLI tools (`rg`, `fd`) to locate real implementations.
3. **Local-First Output:** Save standards directly to the active project's `AGENTS.md` (or project-local `instructions/<topic>.instructions.md`). Never modify global catalogs automatically.
4. **Rule-First Conciseness:** Lead with the rule, provide a short code example, and omit filler text.

---

## Workflow

### 1. Identify Topic & Scope
Parse the target topic from the user request (e.g. *"Document our database session convention"*). If none was specified, prompt the user for the area they want to extract.

### 2. Search Codebase Implementations
Use `justfile.agent` or `rg`/`fd` to find 3–5 representative implementations:
```bash
# Locate relevant files
just -f justfile.agent find-files "<pattern>"
# Or: fd -e py "<pattern>"

# Search implementation patterns
just -f justfile.agent search "<keyword>"
# Or: rg "<keyword>" -t py
```

### 3. Draft Rule-First Standard
Formulate a concise, actionable standard with:
- **Core Rule:** Single clear sentence stating the requirement.
- **Code Example:** Short Good vs. Bad snippet.
- **Exceptions (if any):** Known boundary exceptions.

Example draft format:
```markdown
## Standard: Database Session Scope

Always scope database sessions to the request context using dependency injection. Never instantiate global sessions.

```python
# Good: Request-scoped injection
async def get_user_service(db: AsyncSession = Depends(get_db)):
    return UserService(db)

# Bad: Global session reference
db = SessionLocal()
```
```

### 4. Confirm and Write Locally
Present the drafted standard for confirmation. Upon approval, append to:
- Project root `AGENTS.md` / `GEMINI.md`, or
- Project-local `instructions/<topic>.instructions.md`
