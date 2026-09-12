# Dedicated WSL2 distro for pi

Run pi in its own hardened, disposable WSL2 distro, alongside your daily dev
distro, while still being able to work on code that lives in the dev distro's
`~/DEV`.

> **Executable step-by-step: [`SETUP.md`](SETUP.md).** This file explains the
> design and the reasoning; `SETUP.md` is the runbook.

## Threat model

This is aimed at **agentic accidents, not a determined adversary**. That changes
what matters:

- **Visibility is the main control.** If the pi distro cannot *name* `C:\...`,
  host secrets, or another distro's files, an accidental `rm -rf` can only harm
  the disposable distro or the one directory you deliberately exposed.
- **Recovery beats prevention.** The distro is cattle: export/import to roll
  back. See `snapshot.ps1`.
- We do **not** defend against kernel exploits or sandbox escapes. That is
  out of scope for "accidents".

## What is and isn't shared

All WSL2 distros share **one lightweight utility VM and one Linux kernel** —
that's why `wsl --shutdown` stops everything and why `.wslconfig` is global.

| Boundary | Strength |
| --- | --- |
| Linux distro ↔ Windows | real **VM** boundary (strong) |
| distro ↔ distro (incl. `docker-desktop`) | **namespaces** on a shared kernel (container-grade) |

For accidents, the second one is fine. For adversaries, it isn't — and that's
accepted here.

Windows → distro access still exists and is host-controlled (`\\wsl$` /
`\\wsl.localhost\<distro>\...`, `wsl --mount`). Those are *your* actions, not
things the agent can reach by accident.

## Files

| File | Where it goes |
| --- | --- |
| `wsl.conf` | `/etc/wsl.conf` **in the pi distro** |
| `provision.sh` | run as root in the pi distro (UBI10: installs pi, creates user) |
| `mount-dev.sh` | run inside the pi distro to bridge the dev distro's `~/DEV` |
| `fstab.example` | optional persistence for that mount |
| `snapshot.ps1` | run from Windows PowerShell (export/import/list) |

## Setup

### 1. Create the distro

Either install a stock one:

```powershell
wsl --install -d Debian --name pi
```

…or import a custom rootfs (your "custom distrib"):

```powershell
wsl --import pi "$env:LOCALAPPDATA\wsl\pi" C:\path\to\rootfs.tar --version 2
```

### 2. Harden it

Copy `wsl.conf` to `/etc/wsl.conf` inside the distro, then restart it:

```powershell
wsl --terminate pi
```

Verify from inside:

```bash
ls /mnt            # should be empty / no c
mount | grep drvfs # should show no /mnt/c
powershell.exe -c "echo hi"   # should fail: interop disabled
```

### 3. Provision (UBI10)

The base image already provides Node/npm and the GitHub-release tools (`rg`,
`fd`, ...), so **no RPM repos are needed**. Run the provisioning script as root
inside the distro:

```powershell
wsl -d pi -u root -- bash /path/to/infra/wsl-pi/provision.sh
```

It:
- verifies `node >= 22.19.0` (pi's minimum),
- creates the unprivileged `pi` user referenced by `wsl.conf`,
- installs pi globally (`npm i -g --ignore-scripts @earendil-works/pi-coding-agent`),
- prepares `/home/pi/.pi/agent` and warns if `node`/`pi` won't be on the
  `pi` user's `PATH`.

Then install the hardened config and restart:

```bash
cp wsl.conf /etc/wsl.conf
```

```powershell
wsl --terminate pi
wsl -d pi          # now runs as `pi`
```

If Node lives only in root's home (e.g. `nvm` under `/root`), the `pi` user
won't see it — install Node system-wide (e.g. under `/usr/local`) or fix PATH.

### 4. Secrets

Keep the provider API key **inside** the pi distro (e.g. in `~/.pi/agent` with
`chmod 600`), never somewhere under `C:\` — with `automount` off the distro
can't read `C:\` anyway, but don't rely on that alone. Use a distro-local
`~/.pi/agent`; do **not** mount your host/Windows pi config into it.

## Bridging the dev distro's `~/DEV`

The source of truth is `~/DEV` in the daily dev distro. Expose only that one
directory to the pi distro; nothing else from the dev distro or Windows.

Test first — the DrvFs UNC path is the part that varies by WSL build:

```bash
DEV_DISTRO=<dev-distro> DEV_USER=<dev-user> ./mount-dev.sh
# or manually:
sudo mkdir -p /mnt/dev
sudo mount -t drvfs '\\wsl.localhost\<DEV_DISTRO>\home\<DEV_USER>\DEV' /mnt/dev
ls /mnt/dev
```

If it works, generate the `fstab` line so it survives restarts:

```bash
DEV_DISTRO=<dev-distro> DEV_USER=<dev-user> ./mount-dev.sh --print-fstab
```

Then `cd /mnt/dev/<repo> && pi`. If git reports "dubious ownership", add the
path to `safe.directory` (see `mount-dev.sh`).

Fallback if cross-distro mounting doesn't work on your build: clone/sync the
repo into the pi distro and pull changes back via git (stronger isolation, more
friction). Do **not** move the code to a Windows path — NTFS via DrvFs loses
Unix permissions/exec bits and re-exposes a Windows path to the agent.

## `.wslconfig` is global

`~/.wslconfig` (e.g. `memory=`, `processors=`, `swap=`) applies to **all**
distros, because they share the VM. Don't tune it for pi alone. Per-distro
limits via `.wslconfig` are not a thing. Prefer NAT networking (the default);
`networkingMode=mirrored` increases host integration and is the opposite of what
you want here.

## Disposable

```powershell
.\snapshot.ps1 -Action export  -Distro pi
.\snapshot.ps1 -Action list    -Distro pi
.\snapshot.ps1 -Action restore -Distro pi -Name 20260912-101500
```

Snapshot before anything risky; restore if an accident happens. Because the
distro is easy to rebuild, you can also just `wsl --unregister pi` and start over.

## What could still go wrong

- Whatever the agent does to the mounted `~/DEV` (or a clone) is real. That is
  the job — keep that directory in git/backed up somewhere the distro can't reach.
- Prompt injection (e.g. a malicious README) can turn an accident into an
  attack. `automount`/`interop` off limits the blast radius but is not a full
  defence.
- The shared kernel means distro↔distro isolation is container-grade, not VM-grade.
