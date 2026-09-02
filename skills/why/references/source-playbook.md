# Local Forensic Source Playbook

A practical guide for extracting code motivation and historical context using local git commands and in-repo artifacts.

---

## 1. Git History Investigation

### Find When a Symbol or Pattern Was Introduced / Changed
```bash
# Pickaxe search (find commits where string was added or removed)
git log -S "<pattern>" --source --all -p

# Regex pickaxe
git log -G "<regex>" -p -n 5
```

### Trace Exact Line Changes
```bash
# Blame with commit hash and author date
git blame -L <start>,<end> path/to/file.py

# Trace line evolution over time
git log -L <start>,<end>:path/to/file.py
```

### Read Full Commit Context
```bash
# Show full commit metadata and diff
git show <commit-sha> --stat -p
```

---

## 2. In-Repo Artifacts

1. **Architecture Decision Records (ADRs):** Check `docs/adr/`, `docs/decisions/`, `docs/rfc/`.
2. **Module Docstrings:** Check top of modules for module-level architectural notes.
3. **Changelogs:** Check `CHANGELOG.md` or release notes around the commit date.

---

## 3. GitHub PR Context (via `gh` CLI)

If working in a GitHub-linked repository:
```bash
# View PR description and discussion for linked PR
gh pr view <pr-number> --json title,body,comments
```
