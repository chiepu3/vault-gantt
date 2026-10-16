[CmdletBinding()]
param(
    [string]$Branch,
    [string]$Vault,
    [switch]$Reset,
    [switch]$NoCache
)

# このリポジトリで git pull → 必要なときだけ npm ci → npm run build → 3ファイルを配置する高速インストーラー。
# 配置先は初回だけ聞いて、ユーザー環境変数に覚えておく。
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

function Get-Tool {
    param([string]$Name, [string]$Label)
    $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { throw "${Label}が見つかりません。インストールして PATH を通してから、もう一度実行してください。" }
    return $cmd.Source
}

function Assert-ExitCode {
    param([string]$Name)
    if ($LASTEXITCODE -ne 0) { throw "${Name} が失敗しました（終了コード ${LASTEXITCODE}）。上のメッセージを確認してください。" }
}

function Get-FileSha256 {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        $hash = $sha.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Copy-Artifacts {
    param([string]$RepoRoot, [string]$Destination)
    $names = @('main.js', 'manifest.json', 'styles.css')
    foreach ($n in $names) {
        if (-not [System.IO.File]::Exists([System.IO.Path]::Combine($RepoRoot, $n))) {
            throw "ビルド成果物が見つかりません: $n"
        }
    }
    # 1) 先に全ファイルを .tmp として配置先へ書く（ここで失敗しても既存ファイルは無傷）
    foreach ($n in $names) {
        [System.IO.File]::Copy([System.IO.Path]::Combine($RepoRoot, $n), [System.IO.Path]::Combine($Destination, $n + '.tmp'), $true)
    }
    # 2) 既存の3ファイルを .backup へ退避（前回のバックアップは上書き）
    $backup = [System.IO.Path]::Combine($Destination, '.backup')
    [System.IO.Directory]::CreateDirectory($backup) | Out-Null
    foreach ($n in $names) {
        $current = [System.IO.Path]::Combine($Destination, $n)
        if ([System.IO.File]::Exists($current)) {
            [System.IO.File]::Copy($current, [System.IO.Path]::Combine($backup, $n), $true)
        }
    }
    # 3) .tmp を本来の名前へ置き換え
    foreach ($n in $names) {
        $tmp = [System.IO.Path]::Combine($Destination, $n + '.tmp')
        $final = [System.IO.Path]::Combine($Destination, $n)
        [System.IO.File]::Copy($tmp, $final, $true)
        [System.IO.File]::Delete($tmp)
    }
}

function Install-FromRepository {
    param([string]$Destination)
    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $git = Get-Tool 'git' 'Git'
    $npm = Get-Tool 'npm.cmd' 'npm（Node.js）'

    Push-Location -LiteralPath $repoRoot
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
            throw "このフォルダーは git リポジトリではありません: $repoRoot"
        }

        $dirty = @(& $git status --porcelain --untracked-files=no)
        Assert-ExitCode 'git status'
        if ($dirty.Count -gt 0) {
            throw "リポジトリに未コミットの変更があります。作業内容を守るため中止しました。コミットか破棄してから再実行してください: $repoRoot"
        }

        Write-Host '最新の状態を取得しています（git fetch / pull）...'
        & $git fetch origin --prune
        Assert-ExitCode 'git fetch'

        if ($Branch) {
            & $git show-ref --verify --quiet "refs/heads/$Branch"
            if ($LASTEXITCODE -eq 0) {
                & $git switch $Branch
                Assert-ExitCode 'git switch'
            } else {
                & $git switch -c $Branch --track "origin/$Branch"
                Assert-ExitCode 'git switch -c'
            }
        }

        & $git pull --ff-only
        if ($LASTEXITCODE -ne 0) {
            throw 'git pull --ff-only が失敗しました。ローカルの履歴が origin と分岐しているか、追跡ブランチがありません。手動で解決してから再実行してください。'
        }

        $lock = Join-Path $repoRoot 'package-lock.json'
        $modules = Join-Path $repoRoot 'node_modules'
        $stamp = Join-Path $modules '.vault-gantt-lock-sha256'
        $lockHash = Get-FileSha256 $lock
        $needInstall = $true
        if ($NoCache) {
            Write-Host '-NoCache が指定されたため、依存パッケージを入れ直します。'
        } elseif (-not (Test-Path -LiteralPath $modules -PathType Container)) {
            Write-Host 'node_modules がありません。'
        } elseif (-not (Test-Path -LiteralPath $stamp -PathType Leaf)) {
            Write-Host '依存パッケージの記録がありません。'
        } elseif (([System.IO.File]::ReadAllText($stamp)).Trim() -ne $lockHash) {
            Write-Host 'package-lock.json が変わりました。'
        } else {
            $needInstall = $false
        }
        if ($needInstall) {
            Write-Host '依存パッケージを更新します（npm ci）'
            & $npm ci --no-audit --no-fund
            Assert-ExitCode 'npm ci'
            [System.IO.Directory]::CreateDirectory($modules) | Out-Null
            [System.IO.File]::WriteAllText($stamp, $lockHash)
        } else {
            Write-Host '依存パッケージは変更なし（スキップ）'
        }

        Write-Host 'ビルドしています（npm run build）...'
        & $npm run build
        Assert-ExitCode 'npm run build'

        Copy-Artifacts -RepoRoot $repoRoot -Destination $Destination

        $branchName = (@(& $git rev-parse --abbrev-ref HEAD))[0]
        Assert-ExitCode 'git rev-parse'
        $commit = (@(& $git rev-parse --short HEAD))[0]
        Assert-ExitCode 'git rev-parse'
        Write-Host "インストールしました: ブランチ ${branchName} / コミット ${commit}"
    } finally {
        Pop-Location
    }
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
    Install-FromRepository -Destination $destination

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
