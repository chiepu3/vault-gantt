[CmdletBinding()]
param(
    [string]$Branch,
    [string]$DestinationPath,
    [switch]$NoCache
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VaultGanttInstaller.Lib.ps1')

try {
    Invoke-VaultGanttInstaller -Branch $Branch -DestinationPath $DestinationPath -NoCache:$NoCache
    exit 0
} catch {
    [Console]::Error.WriteLine("[vault-gantt-installer] エラー: $($_.Exception.Message)")
    exit 1
}
