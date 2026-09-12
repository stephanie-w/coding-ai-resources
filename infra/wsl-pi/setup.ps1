<#
.SYNOPSIS
    Create the dedicated pi WSL2 distro from a (team) Docker image.

.DESCRIPTION
    Phase 1 of infra/wsl-pi/SETUP.md. Exports a Docker image's filesystem and
    imports it as a WSL2 distro. No repository is involved; the image is assumed
    to already contain the toolchain (node, rg, fd, ...).

.EXAMPLE
    .\setup.ps1 -Image registry.example.com/team/ubi10-dev:latest
    .\setup.ps1 -Image registry.example.com/team/ubi10-dev:latest -Distro pi -Force
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Image,

    [string]$Distro = "pi",

    [string]$InstallDir = "$env:LOCALAPPDATA\wsl\pi",

    # Unregister an existing distro of the same name first.
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

Assert-Command docker
Assert-Command wsl

# Refuse to clobber an existing distro unless -Force.
$existing = @(wsl -l -q) | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ }
if ($existing -contains $Distro) {
    if (-not $Force) {
        throw "WSL distro '$Distro' already exists. Re-run with -Force to unregister and recreate it."
    }
    Write-Host "Unregistering existing '$Distro'..."
    wsl --unregister $Distro
}

if (Test-Path $InstallDir) {
    if ((Get-ChildItem -Force -LiteralPath $InstallDir | Measure-Object).Count -gt 0) {
        throw "Install dir '$InstallDir' is not empty. Pick another -InstallDir or clear it."
    }
}

$container = "$Distro-rootfs-tmp"
$tar = Join-Path $env:TEMP "$Distro-rootfs.tar"

try {
    Write-Host "Pulling $Image ..."
    docker pull $Image

    Write-Host "Exporting filesystem ..."
    docker rm -f $container 2>$null | Out-Null
    docker create --name $container $Image | Out-Null
    docker export $container -o $tar

    Write-Host "Importing as WSL2 distro '$Distro' ..."
    wsl --import $Distro $InstallDir $tar --version 2

    Write-Host ""
    Write-Host "Created '$Distro'. Verify the toolchain:"
    Write-Host "  wsl -d $Distro -u root -- bash -lc 'node --version; npm --version; command -v rg fd git'"
    Write-Host ""
    Write-Host "Next: SETUP.md phase 2 (provision + harden)."
}
finally {
    docker rm -f $container 2>$null | Out-Null
    if (Test-Path $tar) { Remove-Item $tar -Force }
}
