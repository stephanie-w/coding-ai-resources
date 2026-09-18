# gondolin (pi extension)

Sandboxes all agent file and shell operations (`read`, `write`, `edit`, `bash`, and user `!` commands) inside an isolated **Gondolin Linux micro-VM**.

## Features

- **Micro-VM Isolation**: Runs commands inside a fast QEMU/KVM micro-VM (Alpine Linux).
- **Host Workspace Mounting**: Automatically mounts the current directory read-write at `/workspace` inside the guest.
- **Daily Dev Mounts**: Mounts key host configs (`~/.npm-global`, `~/.pi/agent`, `~/.gitconfig` in read-only mode, and `~/.cache/uv`, `~/.cache/pip`, `~/.npm` in read-write mode) for seamless daily coding.
- **TUI Status**: Displays the live status of the micro-VM in Pi's status bar.
- **Clean Shutdown**: Gracefully stops the micro-VM when the Pi session exits.

## Install

### Global Symlink (Recommended)

```bash
cd pi-extensions/gondolin && npm install
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD" ~/.pi/agent/extensions/gondolin
```

### Run per-session

```bash
pi -e /absolute/path/to/coding-ai-resources/pi-extensions/gondolin/index.ts
```

## Configuration & Environment Variables

- `GONDOLIN_DISABLED=1` (or `NO_SANDBOX=1`): Run natively without starting the micro-VM.
- `GONDOLIN_MOUNTS="HOST:GUEST[:ro],..."`: Mount additional host directories or files into the guest micro-VM.
- `GONDOLIN_DEFAULT_IMAGE`: Custom image path or tag (default: `custom-dev:latest`).

