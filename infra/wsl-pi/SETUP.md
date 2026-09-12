# Runbook: stand up the dedicated `pi` WSL2 distro

Executable flow for the plan described in `README.md`. Windows commands are
marked **PS**, Linux commands run inside a distro.

Route: **export the team UBI10 Docker image → `wsl --import`**, then provision pi
and harden the distro. The image is clean by design (no secrets), so it is
reused as-is.

## Placeholders

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `<TEAM_IMAGE>` | team UBI10 Docker image ref | `registry.example.com/team/ubi10-dev:latest` |
| `<DEV_DISTRO>` | your existing dev distro name | `Ubuntu-Dev` |
| `<DEV_USER>` | your Linux user in the dev distro | `stephanie` |
| `<REPO>` | this repo's path under `~/DEV` | `coding-ai-resources` |

---

## Phase 0 — prerequisites

- Windows with Docker Desktop (WSL2 backend) running, and WSL2 installed.
- The dev distro exists and is running when you bridge it.
- `infra/wsl-pi/` reachable from the pi distro. Before hardening, Windows drives
  are automounted, so the easiest path is:
  - the repo lives in the dev distro under `~/DEV`, and we mount it (below), **or**
  - copy `infra/wsl-pi/` to a Windows path and use `/mnt/c/...`.

---

## Phase 1 — create the distro from the team image **PS**

Either run the script:

```powershell
.\setup.ps1 -Image <TEAM_IMAGE>
```

…or do it manually:

```powershell
docker pull <TEAM_IMAGE>
docker create --name pi-rootfs <TEAM_IMAGE>
docker export pi-rootfs -o $env:TEMP\pi-rootfs.tar
docker rm pi-rootfs

wsl --import pi "$env:LOCALAPPDATA\wsl\pi" "$env:TEMP\pi-rootfs.tar" --version 2
Remove-Item $env:TEMP\pi-rootfs.tar
```

Verify the toolchain came along:

```powershell
wsl -d pi -u root -- bash -lc 'node --version; npm --version; command -v rg fd git'
```

Requirement: `node >= 22.19.0` (pi's minimum). If `git` is missing, pi still
runs but loses git-aware features.

---

## Phase 2 — provision + harden (inside `pi`, as root)

Bring the setup files in. Preferred (also an early test of the bridge):

```bash
# inside `wsl -d pi -u root`
mkdir -p /mnt/dev
mount -t drvfs '\\wsl.localhost\<DEV_DISTRO>\home\<DEV_USER>\DEV' /mnt/dev
ls /mnt/dev                      # sanity: your code is visible
cp -r /mnt/dev/<REPO>/infra/wsl-pi /root/wsl-pi
```

If that mount fails, fall back to a Windows copy:

```bash
cp -r /mnt/c/path/to/infra/wsl-pi /root/wsl-pi
```

Then install pi and the hardened config:

```bash
bash /root/wsl-pi/provision.sh
cp /root/wsl-pi/wsl.conf /etc/wsl.conf
chmod +x /root/wsl-pi/mount-dev.sh
```

`provision.sh` creates the unprivileged `pi` user, installs
`@earendil-works/pi-coding-agent` globally, and prepares `/home/pi/.pi/agent`.

---

## Phase 3 — restart and verify **PS**

```powershell
wsl --terminate pi
wsl -d pi
```

Inside, confirm the hardening:

```bash
whoami                        # pi
ls /mnt                       # no c
powershell.exe -c "echo hi"   # fails: interop disabled
```

Put your provider key / pi config in `/home/pi/.pi/agent` (mode 600). It lives in
the distro, not on the host.

---

## Phase 4 — persist the `~/DEV` bridge

The mount needs the dev distro **running**. Two ways to make it survive restarts.

### Option A: `/etc/fstab` (standard)

```powershell
wsl -d pi -u root -- bash -lc 'DEV_DISTRO=<DEV_DISTRO> DEV_USER=<DEV_USER> /root/wsl-pi/mount-dev.sh --print-fstab >> /etc/fstab'
wsl -d pi -u root -- mount -a
```

Then, as `pi`: `ls /mnt/dev`.

If `mount -a` reports a bad source, the shell parser is mangling the UNC
backslashes. Replace every `\` in the generated source with `\134`, or use
Option B.

### Option B: boot command (no fstab escaping)

Create the config:

```bash
# inside `wsl -d pi -u root`
cat > /etc/pi-wsl.env <<'EOF'
DEV_DISTRO=<DEV_DISTRO>
DEV_USER=<DEV_USER>
EOF
chmod 600 /etc/pi-wsl.env
```

Then uncomment in `/etc/wsl.conf`:

```ini
[boot]
command = /root/wsl-pi/mount-dev.sh --boot
```

`--boot` reads `/etc/pi-wsl.env` and never fails the distro start (if the dev
distro is down, `/mnt/dev` is simply absent — start the dev distro and run
`mount-dev.sh --boot` again).

> The boot command is expected to run as root; verify with
> `wsl -d pi -u root -- bash -lc 'id -u'` after a restart if the mount is missing.

---

## Phase 5 — make it disposable **PS**

```powershell
.\snapshot.ps1 -Action export -Distro pi
.\snapshot.ps1 -Action list   -Distro pi
.\snapshot.ps1 -Action restore -Distro pi -Name <timestamp>
```

Snapshot before risky work. Restoring `pi` never touches the dev distro or your
code.

---

## Daily use

```powershell
wsl -d <DEV_DISTRO> -- true      # ensure the dev side is up (if using the bridge)
wsl -d pi
```
```bash
cd /mnt/dev/<REPO>
pi
```

---

## Rollback / teardown

```powershell
wsl --unregister pi                                   # delete the pi distro
docker rmi <TEAM_IMAGE>                               # optional
```
Your dev distro and code are untouched; recreate with Phase 1.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `mount-dev.sh` fails | dev distro not running; start it first (`wsl -d <DEV_DISTRO> -- true`) |
| `/mnt/dev` missing after restart | fstab source misparsed (use `\134` escapes) or boot command didn't run as root — see Phase 4 |
| git: "dubious ownership" | `git config --global --add safe.directory /mnt/dev/<repo>` |
| `pi` not found after provision | node lives in root's home (e.g. nvm); install node system-wide or fix `PATH` |
| `node` version too old | image predates pi's `>=22.19.0`; rebuild the team image or add a newer node |
| `/mnt/c` still present | `wsl.conf` not installed, or distro not restarted (`wsl --terminate pi`) |
| `powershell.exe` still runs | interop not disabled, or distro not restarted |

---

## Scope note

This is the work environment. bash-guard stays as the (already simplified)
secondary layer and is not being extended here; home keeps the current
bash-guard for now.
