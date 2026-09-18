# secrets-guard (pi extension)

Protects against sensitive file reads, credential dumping, API key leakage, and out-of-workspace filesystem snooping.

## Features

- **Workspace Jailing**: Prompts (main session) or hard-blocks (subagent) any attempt by tools (`read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`) to access paths outside the project root (except `/tmp`).
- **Secret & Credential Protection**:
  - Dotfiles & shell configurations (`~/.bashrc`, `~/.zshrc`, `~/.profile`, `/etc/shadow`, `/etc/sudoers`).
  - Cloud and SSH credentials (`~/.ssh`, `~/.aws`, `~/.kube`, `~/.gnupg`, `~/.netrc`, `~/.git-credentials`, `~/.config/gcloud`, `~/.config/gh`, `~/.docker/config.json`).
  - Secret files (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`). Template exceptions like `.env.example` are automatically permitted.
- **Environment Dump Defense**: Blocks or prompts on `env`, `printenv`, `export -p`, `set`, and `/proc/*/environ` reads.
- **Subagent Headless Hard-Block**: Subagents (`PI_SUBAGENT_DEPTH >= 1`) are strictly jailed and cannot read credentials or wander outside the workspace.
- **Interactive TUI Modal**: Clean confirmation dialogs in main sessions displaying the exact path/command and security risk.

## Commands & Flags

- `/secrets-guard`: Toggle secrets-guard on/off for the current session.
- `--secrets-guard-disabled`: Start session with guard disabled (subagent hard-block floor still applies).
- `--secrets-guard-auto-allow`: Allow in headless/non-interactive test scripts.
