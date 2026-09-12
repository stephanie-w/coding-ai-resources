#!/usr/bin/env bash
#
# Provision the dedicated pi distro (RHEL-family / UBI10 base).
# Run as root INSIDE the pi distro:
#
#   wsl -d pi -u root -- bash /path/to/provision.sh
#
# This script deliberately does NOT touch dnf: the base image already provides
# node/npm and the GitHub-release tools (rg, fd, ...), and the UBI10 repos are
# intentionally minimal.
set -euo pipefail

PI_USER="${PI_USER:-pi}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run as root (wsl -d pi -u root -- bash provision.sh)"

log "Checking prerequisites"
command -v node >/dev/null || die "node not found on PATH"
command -v npm >/dev/null || die "npm not found on PATH"

node -e "
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < ${MIN_NODE_MAJOR} || (maj === ${MIN_NODE_MAJOR} && min < ${MIN_NODE_MINOR})) {
    console.error('found node ' + process.versions.node);
    process.exit(1);
  }
" || die "pi requires node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}"

for t in rg fd git; do
  command -v "$t" >/dev/null || warn "$t not found (pi works without it, but better with it)"
done

log "Ensuring user ${PI_USER}"
if id "$PI_USER" >/dev/null 2>&1; then
  log "${PI_USER} already exists"
else
  useradd --create-home --shell /bin/bash "$PI_USER"
  log "created ${PI_USER}"
fi

log "Installing pi globally"
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

PI_BIN="$(command -v pi || true)"
[[ -n "$PI_BIN" ]] || die "pi not on PATH after install (check 'npm prefix -g')"
log "pi installed at ${PI_BIN}"

log "Preparing /home/${PI_USER}/.pi/agent"
install -d -o "$PI_USER" -g "$PI_USER" -m 700 "/home/${PI_USER}/.pi/agent"

# If node lives only in root's home (e.g. nvm under /root), the pi user will not
# see it. Catch that here rather than at first launch.
if ! su - "$PI_USER" -c 'command -v node >/dev/null && command -v pi >/dev/null'; then
  warn "${PI_USER} cannot resolve node/pi on PATH — install node system-wide or fix PATH."
fi

log "Done. Remaining steps:"
cat <<'EOF'
  1. install hardened config:  cp wsl.conf /etc/wsl.conf
  2. restart the distro:       (from Windows) wsl --terminate pi
  3. launch as pi:             wsl -d pi
  4. optional ~/DEV bridge:    DEV_DISTRO=... DEV_USER=... ./mount-dev.sh
EOF
