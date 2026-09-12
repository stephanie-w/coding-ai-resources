# Pi agent extensions

- neovim : Native Neovim RPC integration extension for the Pi coding agent. Gives Pi live awareness of active files, cursor positions, unsaved in-memory buffers, and remote command execution.
- git-checkpoint : Manual, durable, reversible git snapshots of the working tree via `/checkpoint` and `/rollback`, stored as refs under `refs/pi/checkpoints/`. Fully decoupled from `/tree` and `/fork`.
- bash-guard : Intercepts agent-issued `bash` tool calls and prompts before destructive commands (main session) or hard-blocks catastrophic ones (subagents).
