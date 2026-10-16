[CmdletBinding()]
param(
    [string]$Branch,
    [string]$Vault,
    [switch]$Reset,
    [switch]$NoCache
)

# Install-VaultGantt.ps1 の短縮版。配置先を初回だけ聞いて、ユーザー環境変数に覚えておく。
$ErrorActionPreference = 'Stop'
$envName = 'VAULT_GANTT_DEST'

function Get-PluginFolder {
    param([string]$Path)
    $Path = $Path.Trim().Trim('"').TrimEnd('\', '/')
    $leaf = Split-Path -Leaf $Path
    $parent = Split-Path -Leaf (Split-Path -Parent $Path)
    if ($leaf -ieq 'vault-gantt' -and $parent -ieq 'plugins') { return $Path }
    return Join-Path $Path '.obsidian\plugins\vault-gantt'
}

function Get-ObsidianVaults {
    $config = Join-Path $env:APPDATA 'obsidian\obsidian.json'
    if (-not (Test-Path -LiteralPath $config)) { return @() }
    try { $json = [System.IO.File]::ReadAllText($config) | ConvertFrom-Json } catch { return @() }
    if (-not $json.vaults) { return @() }
    return @($json.vaults.PSObject.Properties | ForEach-Object { [string]$_.Value.path } |
        Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ '.obsidian') -PathType Container) })
}

function Read-VaultFolder {
    $vaults = @(Get-ObsidianVaults)
    if ($vaults.Count -gt 0) {
        Write-Host 'インストール先の Vault を選んでください:'
        for ($i = 0; $i -lt $vaults.Count; $i++) { Write-Host ("{0}. {1}" -f ($i + 1), $vaults[$i]) }
        Write-Host '0. 一覧にない場所を入力する'
        $choice = Read-Host '番号を選択（Enter で 1）'
        if (-not $choice) { $choice = '1' }
        $n = 0
        if ([int]::TryParse($choice, [ref]$n) -and $n -ge 1 -and $n -le $vaults.Count) { return $vaults[$n - 1] }
        if ($choice -ne '0') { throw "選択番号が不正です: $choice" }
    }
    return Read-Host 'Vault のフォルダーのパス（エクスプローラーからこの画面へドラッグしても入力できます）'
}

try {
    if ($Reset) {
        [Environment]::SetEnvironmentVariable($envName, $null, 'User')
        Remove-Item -Path "Env:$envName" -ErrorAction SilentlyContinue
        Write-Host '保存していたインストール先を消しました。'
    }

    $saved = [Environment]::GetEnvironmentVariable($envName, 'User')
    if (-not $saved) { $saved = [Environment]::GetEnvironmentVariable($envName, 'Process') }

    if ($Vault) { $destination = Get-PluginFolder $Vault }
    elseif ($saved -and -not $Reset) { $destination = $saved }
    else {
        $answer = Read-VaultFolder
        if ([string]::IsNullOrWhiteSpace($answer)) { throw 'Vault のフォルダーが入力されていません。' }
        $destination = Get-PluginFolder $answer
    }

    $obsidianFolder = Split-Path -Parent (Split-Path -Parent $destination)
    if (-not (Test-Path -LiteralPath $obsidianFolder -PathType Container)) {
        throw "Obsidian の Vault ではないようです（.obsidian フォルダーがありません）: $obsidianFolder"
    }
    if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
        New-Item -ItemType Directory -Path $destination | Out-Null
    }

    Write-Host "インストール先: $destination"
    & (Join-Path $PSScriptRoot 'Install-VaultGantt.ps1') -Branch $Branch -DestinationPath $destination -NoCache:$NoCache
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if ($destination -ne $saved) {
        [Environment]::SetEnvironmentVariable($envName, $destination, 'User')
        Write-Host "次回からはこのインストール先を自動で使います（変えるときは -Reset を付けて実行）。"
    }
    Write-Host 'Obsidian を再起動して、設定 → コミュニティプラグインで「Vault Gantt」をオンにしてください。'
    exit 0
} catch {
    [Console]::Error.WriteLine("[vault-gantt-installer] エラー: $($_.Exception.Message)")
    exit 1
}
