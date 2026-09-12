<#
.SYNOPSIS
    Export / import the dedicated pi WSL distro for disposable rollback.

.DESCRIPTION
    Run from Windows PowerShell. Treat the pi distro as cattle: snapshot before
    risky work, restore if an accident happens. This is the recovery half of the
    "accidents, not adversaries" threat model.

.EXAMPLE
    .\snapshot.ps1 -Action export -Distro pi
    .\snapshot.ps1 -Action restore -Distro pi -Name 20260912-101500
    .\snapshot.ps1 -Action list -Distro pi
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("export", "restore", "list")]
    [string]$Action,

    [string]$Distro = "pi",

    [string]$Dir = "$env:USERPROFILE\pi-snapshots",

    # Snapshot name; defaults to a timestamp for export, required for restore.
    [string]$Name
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

switch ($Action) {
    "export" {
        if (-not $Name) { $Name = Get-Date -Format "yyyyMMdd-HHmmss" }
        $target = Join-Path $Dir "$Distro-$Name.tar"
        Write-Host "Terminating $Distro..."
        wsl --terminate $Distro | Out-Null
        Write-Host "Exporting $Distro -> $target"
        wsl --export $Distro $target
        Write-Host "Done. Re-import with: .\snapshot.ps1 -Action restore -Distro $Distro -Name $Name"
    }
    "restore" {
        if (-not $Name) { throw "-Name is required for restore (see -Action list)." }
        $source = Join-Path $Dir "$Distro-$Name.tar"
        if (-not (Test-Path $source)) { throw "Snapshot not found: $source" }
        Write-Host "Unregistering current $Distro (this deletes it)..."
        wsl --unregister $Distro
        # Import path: the vhdx is created under %LOCALAPPDATA%\wsl\pi.
        $install = Join-Path $env:LOCALAPPDATA "wsl\$Distro"
        New-Item -ItemType Directory -Force -Path $install | Out-Null
        Write-Host "Importing $source -> $install"
        wsl --import $Distro $install $source --version 2
        Write-Host "Restored. Launch with: wsl -d $Distro"
    }
    "list" {
        Get-ChildItem -Path $Dir -Filter "$Distro-*.tar" |
            Sort-Object LastWriteTime -Descending |
            Select-Object LastWriteTime, @{ n = "Name"; e = { $_.BaseName -replace "^$Distro-", "" } }, @{ n = "SizeMB"; e = { [math]::Round($_.Length / 1MB, 1) } } |
            Format-Table -AutoSize
    }
}
