#!/usr/bin/env bash
#
# Expose the daily dev distro's ~/DEV to the *pi* distro at /mnt/dev.
# This is the single controlled bridge between the two distros.
#
# Usage:
#   DEV_DISTRO=Ubuntu DEV_USER=stephanie sudo -E ./mount-dev.sh
#   DEV_DISTRO=Ubuntu DEV_USER=stephanie ./mount-dev.sh --print-fstab
#   ./mount-dev.sh --boot        # reads /etc/pi-wsl.env, never fails boot
#
# Env:
#   DEV_DISTRO  WSL distro name of the dev env (`wsl -l -v` on Windows)
#   DEV_USER    Linux user in that distro
#   MOUNT_POINT where to expose it (default: /mnt/dev)
#   PI_USER     local owner of the mount (default: pi)
#   UID_ARG     override owner uid (default: PI_USER's uid)
#   GID_ARG     override owner gid (default: PI_USER's gid)
#   DRVFS_OPTS  override mount options
#   ENV_FILE    config sourced by --boot (default: /etc/pi-wsl.env)
#
# Notes:
#   - The dev distro must be running, or the mount fails.
#   - DrvFs does not fully preserve ext4 ownership/exec bits across distros.
#     If git complains about "dubious ownership":
#       git config --global --add safe.directory /mnt/dev/<repo>
set -euo pipefail

MODE="${1:-}"
ENV_FILE="${ENV_FILE:-/etc/pi-wsl.env}"

if [[ "$MODE" == "--boot" && -f "$ENV_FILE" ]]; then
	# shellcheck disable=SC1090
	set -a
	. "$ENV_FILE"
	set +a
fi

if [[ -z "${DEV_DISTRO:-}" || -z "${DEV_USER:-}" ]]; then
	if [[ "$MODE" == "--boot" ]]; then
		echo "mount-dev: DEV_DISTRO/DEV_USER not set in $ENV_FILE; skipping." >&2
		exit 0
	fi
	echo "ERROR: set DEV_DISTRO and DEV_USER (see header)." >&2
	exit 1
fi

MOUNT_POINT="${MOUNT_POINT:-/mnt/dev}"
PI_USER="${PI_USER:-pi}"
UID_ARG="${UID_ARG:-$(id -u "$PI_USER" 2>/dev/null || id -u)}"
GID_ARG="${GID_ARG:-$(id -g "$PI_USER" 2>/dev/null || id -g)}"
DRVFS_OPTS="${DRVFS_OPTS:-uid=${UID_ARG},gid=${GID_ARG},umask=022}"

# UNC path to the dev distro's home, as seen by the WSL host:
#   \\wsl.localhost\<distro>\home\<user>\DEV
SOURCE="\\\\wsl.localhost\\${DEV_DISTRO}\\home\\${DEV_USER}\\DEV"

if [[ "$MODE" == "--print-fstab" ]]; then
	echo "${SOURCE}  ${MOUNT_POINT}  drvfs  defaults,${DRVFS_OPTS},nofail  0 0"
	exit 0
fi

if grep -qs " ${MOUNT_POINT} " /proc/mounts; then
	echo "mount-dev: ${MOUNT_POINT} already mounted." >&2
	exit 0
fi

make_mount() {
	mkdir -p "$MOUNT_POINT"
	mount -t drvfs "$SOURCE" "$MOUNT_POINT" -o "$DRVFS_OPTS"
}

if ! make_mount; then
	if [[ "$MODE" == "--boot" ]]; then
		echo "mount-dev: mount failed (is '${DEV_DISTRO}' running?); continuing." >&2
		exit 0
	fi
	exit 1
fi

echo "Mounted ${SOURCE} -> ${MOUNT_POINT}"
ls -la "$MOUNT_POINT" | head
