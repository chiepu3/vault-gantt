<#
.SYNOPSIS
  GitHub Actionsの検証済みartifactから、VaultのVault Gantt 3ファイル(main.js/manifest.json/styles.css)だけを更新/rollbackする。
.DESCRIPTION
  既定はdry-run。実更新/実rollbackは -Apply が必要。詳細は tools/updater/README.md。
.EXAMPLE
  .\Update-VaultGantt.ps1 -Repository owner/name -RunId 123 -ExpectedCommit <40桁SHA> -VaultPath D:\PreviewVault
.EXAMPLE
  .\Update-VaultGantt.ps1 -Rollback -BackupDir $env:TEMP\vault-gantt-updater\backup-... -VaultPath D:\PreviewVault -Apply
#>
[CmdletBinding(DefaultParameterSetName = 'Update')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Update')][string]$RunId,
    [Parameter(Mandatory, ParameterSetName = 'Update')][string]$ExpectedCommit,
    [Parameter(Mandatory, ParameterSetName = 'Update')][string]$Repository,
    [Parameter(ParameterSetName = 'Update')][string]$ExpectedBranch = 'main',
    [Parameter(ParameterSetName = 'Update')][string]$ExpectedWorkflowId,
    [Parameter(Mandatory, ParameterSetName = 'Rollback')][switch]$Rollback,
    [Parameter(Mandatory, ParameterSetName = 'Rollback')][string]$BackupDir,
    [Parameter(Mandatory, ParameterSetName = 'Update')][Parameter(Mandatory, ParameterSetName = 'Rollback')][string]$VaultPath,
    [switch]$Apply,
    [switch]$AllowSyncedVault,
    [switch]$SyncPausedConfirmed,
    [switch]$UseObsidianCli,
    [string]$ObsidianCliVaultName,
    [string]$ObsidianCliPath = 'obsidian',
    [string]$WorkRoot,
    [Parameter(ParameterSetName = 'Update')][string]$GhPath = 'gh'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VaultGanttUpdater.Lib.ps1')
try {
    $common = @{
        VaultPath = $VaultPath; Apply = $Apply; AllowSyncedVault = $AllowSyncedVault; SyncPausedConfirmed = $SyncPausedConfirmed
        UseObsidianCli = $UseObsidianCli; ObsidianCliVaultName = $ObsidianCliVaultName; ObsidianCliPath = $ObsidianCliPath; WorkRoot = $WorkRoot
    }
    if ($PSCmdlet.ParameterSetName -eq 'Rollback') {
        $null = Invoke-VaultGanttRollback @common -BackupDir $BackupDir
    } else {
        $null = Invoke-VaultGanttUpdate @common -RunId $RunId -ExpectedCommit $ExpectedCommit -Repository $Repository -ExpectedBranch $ExpectedBranch -ExpectedWorkflowId $ExpectedWorkflowId -GhPath $GhPath
    }
    exit 0
} catch {
    $code = 1
    if ($_.Exception.Data.Contains('ExitCode')) { $code = [int]$_.Exception.Data['ExitCode'] }
    [Console]::Error.WriteLine("[vault-gantt] エラー: $(Hide-Secrets $_.Exception.Message)")
    exit $code
}
