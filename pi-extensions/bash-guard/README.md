# bash-guard (pi extension)

Intercepts agent-issued `bash` tool calls and applies different protection depending on whether
the session is interactive (main session) or non-interactive (spawned subagent).

## Modes

Behaviour is determined at registration time via the `PI_SUBAGENT_DEPTH` environment variable,
which pi-subagents injects into every spawned process.

### Main session (`PI_SUBAGENT_DEPTH` = 0 or unset) — interactive prompt

- Heuristically detects destructive/questionable commands via shell-aware parsing
- Prompts for destructive git: `git rm`, `git clean -f`, `git reset --hard`,
  `git checkout`/`git restore` that overwrite the working tree, `git push` (all pushes),
  `git reflog expire`, `git gc --prune`. Read-only and routine local git (`status`, `log`, `diff`,
  `add`, `commit`, `fetch`, ...) passes through silently.
- Prompts for disk/volume tooling: `diskutil`, `hdiutil`, `mkfs*`, `newfs_*`, `wipefs`, `parted`,
  `fdisk`, `gdisk/sgdisk`, `cryptsetup`, `pvcreate/vgcreate/lvcreate`, `zpool`, `lsblk`
- Prompts for: `rm`/`rmdir`/`unlink`, `sudo`, `find -delete`, `xargs rm`, `dd`, `truncate`, `sed -i`,
  `perl -pi`, `chmod/chown -R`, `mv/cp --force`, `kill`/`pkill`/`killall`, `shutdown`/`reboot`,
  `systemctl stop/disable`, `kubectl delete`, `terraform destroy`, `aws s3 rm --recursive`,
  `gcloud delete`, redirection to a device/special file (`> /dev/sda`, `/proc/...`, `/sys/...`), and
  redirection to a sensitive system path (`/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/boot`, `/opt`,
  `/System`, `/Library`, `/root`, plus `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker/config.json`,
  `~/.config/gcloud`, `~/.config/gh`)
- Deliberately **does not** prompt for routine plumbing: pipes, input redirection (`<`), regular-file
  writes to an ordinary file (`>`/`>>` — equivalent to the unguarded `write` tool), `/dev/null`, or fd
  duplication (`2>&1`, `>&2`). Here-doc bodies are treated as data, so writing a script with
  `cat > script.sh <<'EOF' … EOF` does not trip the scanner. Only a pipe into a shell
  (`curl … | bash`) is escalated.
- Shows a 2-option dialog: **Run** / **Abort**, with the command rendered as a syntax-highlighted
  `$`-prompted block; pipelines are split onto indented lines (`|`, `&&`, `||`) for readability.
- If aborted, the tool call is blocked and the model receives a clear reason
- Remembers recently aborted commands for 60 s to prevent retry loops

### Subagent (`PI_SUBAGENT_DEPTH` ≥ 1) — headless hard-block

Spawned subagents have no UI (stdin is `/dev/null`), so prompting is impossible. Instead,
a focused set of catastrophic/unrecoverable operations is hard-blocked with no user interaction:

| Pattern | Reason |
|---|---|
| `rm -r` / `-rf` / `-Rf` | Recursive deletion |
| `sudo` | Elevated privileges |
| `curl\|sh`, `wget\|sh` | Pipe to shell (remote code execution) |
| `mkfs*`, `newfs_*` | Filesystem formatting |
| `wipefs` | Disk signature wipe |
| `diskutil erase/zeroDisk/secureErase/reformat` | Destructive disk operation |
| `dd of=/dev/…` | Raw disk write |
| `parted`, `fdisk`, `gdisk`, `sgdisk` | Partition table management |
| `cryptsetup` | Disk encryption management |
| `zpool` | ZFS pool management |
| `shutdown`, `reboot`, `halt`, `poweroff` | System power operation |
| `terraform destroy` | Infrastructure teardown |
| `kubectl delete` | Kubernetes resource deletion |
| `aws s3 rm --recursive` | Bulk S3 deletion |
| `git commit` | Main-session operation |
| `git pull` | Main-session operation |
| `git push` | Main-session operation |
| `git reset --hard` | Discard all uncommitted changes |
| `git clean -f` | Delete untracked files |
| `git reflog expire` | Remove recovery history |
| `git gc --prune` | Prune unreachable objects |

All other commands (including routine git operations) pass through unaffected.

## Install

Auto-discovered from `~/.pi/agent/extensions/bash-guard/`. Run `/reload` in pi.

## Notes

- Scope: `bash` tool calls only (`write`/`edit` and user `!` commands are not intercepted).
- `--bash-guard-auto-allow`: main-session flag that allows flagged commands when there is no UI
  (e.g. running pi non-interactively). Has no effect in subagent sessions.
