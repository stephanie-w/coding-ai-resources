# git-checkpoint (pi extension)

Manual, durable, lossless code snapshots for the [pi coding agent](https://pi.dev).

Pi's `/tree`, `/fork`, and `/clone` branch the **conversation**. They never touch
files on disk. This extension gives you the missing half: explicit, reversible
snapshots of the **working tree**, stored as real git refs so nothing is ever lost.

> **Fully decoupled by design.** It does not hook `/tree` or `/fork`. Restoring
> files only ever happens when *you* run `/rollback`. Nothing changes under you.

---

## Commands

| Command | Behavior |
|---|---|
| `/checkpoint [label]` | Snapshot the working tree (tracked + untracked, non-ignored) to `refs/pi/checkpoints/<id>`. Label is optional. |
| `/rollback [n]` | Restore the working tree to checkpoint `n` (1 = most recent). No argument opens a picker. |
| `/rollback <text>` | Match a checkpoint by label or short SHA. Ambiguous matches open a picker. |
| `/checkpoint list` | List checkpoints and optionally roll back to one. |

`/rollback` always snapshots the current state first, so it is itself undoable.

---

## Safety model

**Invariant: before anything is replaced, the current state is snapshotted.**

A rollback therefore never destroys work — it moves it to another ref that you can
roll back to in turn. The success message tells you the safety snapshot's label.

- Snapshots are **real commits referenced by refs**, not `git stash create`
  objects. `git gc` cannot collect them.
- Your **`HEAD`, branch, and commit history are never moved**.
- **Untracked, non-ignored files are included** in snapshots.
- Before restoring, `/rollback` cleans untracked files so a divergent untracked
  file cannot block the checkout. Everything removed is already in the safety
  snapshot.

### Caveats

- `git clean -fd` removes untracked, **non-ignored** files that were created after
  the target snapshot. Ignored files (e.g. `node_modules/`, build output) are left
  alone. Removed files remain recoverable from the safety snapshot.
- A rollback replaces the index as well as the working tree, so any changes you had
  *staged* are covered by the safety snapshot but are no longer staged afterwards.
- Snapshots include every non-ignored file in the repo, so a repo with large
  untracked directories makes `/checkpoint` slower and the snapshot larger.
- Requires `git` and a POSIX `env` on `PATH` (macOS/Linux) to inject
  `GIT_INDEX_FILE` for a temp-index snapshot that never disturbs your real index.

---

## How it works

### Snapshot

Using a **temporary index** (`GIT_INDEX_FILE`), so your real index is untouched:

1. `git read-tree HEAD` (or `--empty` on an unborn branch)
2. `git add -A` — stages tracked changes and untracked, non-ignored files
3. `git write-tree`
4. `git commit-tree <tree> -p HEAD -m "pi checkpoint: <label>"`
5. `git update-ref refs/pi/checkpoints/<ms>-<slug> <commit>`

Ref names start with a millisecond timestamp, so listing is sortable and
newest-first. The commit body records the session file and leaf entry id for
traceability.

### Restore

1. Snapshot the current state as `pre-rollback-<sha>`.
2. `git clean -fd`
3. `git read-tree --reset -u <commit>` — resets index + working tree, **not HEAD**
4. `git reset -q` — unstage, leaving a normal uncommitted diff

### Inspect / manual recovery

```bash
git for-each-ref refs/pi/checkpoints \
  --format='%(refname:short)  %(subject)  %(creatordate:iso8601)' --sort=-refname

# Restore manually without the extension:
git clean -fd && git read-tree --reset -u <commit> && git reset

# Delete a checkpoint:
git update-ref -d refs/pi/checkpoints/<id>
```

---

## Install

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/index.ts" ~/.pi/agent/extensions/git-checkpoint.ts
# or symlink/copy the whole directory (package.json enables the pi.extensions entry)
```

Then run `/reload` in pi.

---

## Why not just use pi's `git-checkpoint.ts` example?

Pi ships `examples/extensions/git-checkpoint.ts`, which stashes at each turn and
offers to restore **only when you fork the conversation**. It is a useful
skeleton, but for "safe rollback" it has gaps:

| Official example | This extension |
|---|---|
| `git stash create` — unreferenced objects, `git gc` can delete them | Real commits behind refs — durable |
| Excludes untracked files | Includes untracked, non-ignored files |
| Restores only on `/fork` | Explicit `/rollback` at any time |
| Does not handle `/tree` navigation | Still decoupled — but you can roll back after any navigation |
| In-memory `Map`, cleared at `agent_settled` | Git refs survive restarts and session changes |
| No manual snapshot/restore | `/checkpoint`, `/rollback`, `/checkpoint list` |

The deliberate design choice here is to **keep code state decoupled from
conversation branching**. `/tree` is a conversation feature; overloading it to
silently reset files would be surprising and could lose work. Snapshots plus an
explicit `/rollback` keep both mechanisms predictable.
