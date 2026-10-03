# Vault Gantt Faroe updater - library (dot-sourced by Update-VaultGantt.ps1).
# Standard Windows PowerShell 5.1 / PowerShell 7 only. No external modules.
# Never prints tokens; never runs `gh auth login`.

Set-StrictMode -Version 2.0

$script:PluginId = 'vault-gantt'
$script:PayloadFiles = @('main.js', 'manifest.json', 'styles.css')
$script:MetaFiles = @('metadata.json', 'SHA256SUMS')
$script:WorkflowFile = '.github/workflows/faroe-artifact.yml'
$script:MaxEntryBytes = 16MB
$script:SyncPluginIds = @('remotely-save', 'obsidian-livesync', 'obsidian-git')

# Exit codes: 1 failure (rolled back) / 2 validation refused / 3 manual step needed (nothing written)
#             4 safety gate denied / 5 failure AND rollback incomplete / 6 another transaction holds the Vault lock
function Stop-Updater {
    param([string]$Message, [int]$Code = 2)
    $ex = New-Object System.InvalidOperationException($Message)
    $ex.Data['ExitCode'] = $Code
    throw $ex
}

function Write-Info { param([string]$Message) Write-Host "[vault-gantt] $Message" }

function Hide-Secrets {
    param([string]$Text)
    if (-not $Text) { return '' }
    $t = $Text -replace '(gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]+)', '***'
    $t = $t -replace '(?i)(bearer|token)\s+\S+', '$1 ***'
    if ($t.Length -gt 300) { $t = $t.Substring(0, 300) + '...' }
    return $t
}

function Get-Prop {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

# ---------- path safety ----------

function Get-NormPath {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\', '/') }
    return $full
}

function Test-PathUnder {
    param([string]$Child, [string]$Parent)
    $c = Get-NormPath $Child
    $p = Get-NormPath $Parent
    if ($c.Equals($p, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    $sep = [string][System.IO.Path]::DirectorySeparatorChar
    $prefix = $p.TrimEnd('\', '/') + $sep
    return $c.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-InOneDrive {
    param([string]$Path)
    $full = Get-NormPath $Path
    if ($full -match '(?i)(^|[\\/])OneDrive[^\\/]*([\\/]|$)') { return $true }
    foreach ($name in 'OneDrive', 'OneDriveConsumer', 'OneDriveCommercial') {
        $v = [System.Environment]::GetEnvironmentVariable($name)
        if ($v -and (Test-PathUnder $full $v)) { return $true }
    }
    return $false
}

# Strict: any reparse point counts (our own temp dirs). Non-strict (Vault): only
# symlinks/junctions/reparse directories, so OneDrive cloud placeholder files pass.
function Test-IsLink {
    param([string]$Path, [switch]$Strict)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $reparse = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    if ($Strict) { return $reparse }
    $lt = Get-Prop $item 'LinkType'
    if ($lt -eq 'SymbolicLink' -or $lt -eq 'Junction') { return $true }
    return ($reparse -and $item.PSIsContainer)
}

# Target files: reject symlinks/junctions and any other reparse point, except OneDrive
# cloud placeholders (reparse + a cloud-file attribute: Offline/RecallOnOpen/Pinned/Unpinned/RecallOnDataAccess).
function Test-IsUnsafeTargetFile {
    param($Item)
    $lt = Get-Prop $Item 'LinkType'
    if ($lt) { return $true }
    $attr = [int]$Item.Attributes
    if (($attr -band 0x400) -eq 0) { return $false }
    $cloudBits = 0x1000 -bor 0x40000 -bor 0x80000 -bor 0x100000 -bor 0x400000
    return (($attr -band $cloudBits) -eq 0)
}

# Walks Path -> Root (inclusive of Path, exclusive of Root's parents) and rejects links.
function Assert-NoLinkChain {
    param([string]$Path, [string]$Root, [string]$What, [switch]$Strict)
    $cur = Get-NormPath $Path
    $rootN = Get-NormPath $Root
    if (-not (Test-PathUnder $cur $rootN)) { Stop-Updater "$What が許可範囲外です: $cur" 2 }
    while ($true) {
        if (Test-Path -LiteralPath $cur) {
            if (Test-IsLink -Path $cur -Strict:$Strict) { Stop-Updater "$What にシンボリックリンク/ジャンクション/reparse pointが含まれます: $cur" 2 }
        }
        if ($cur.Equals($rootN, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cur = Split-Path -Parent $cur
    }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-JsonFile {
    param([string]$Path, [string]$What)
    try {
        return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        Stop-Updater "$What のJSONを解析できません: $Path" 2
    }
}

# ---------- gh access (overridable in tests) ----------

# Kills only the process this updater started (and its descendants), never anything else.
function Stop-OwnedProcess {
    param([System.Diagnostics.Process]$Process)
    try {
        if ($Process.HasExited) { return }
        $tk = Get-Command -Name 'taskkill.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($tk) { & $tk.Source /T /F /PID $Process.Id 2>&1 | Out-Null }
        if (-not $Process.HasExited) { $Process.Kill() }
    } catch { }
}

# stdout/stderr are drained asynchronously (no pipe deadlock) and TimeoutSec is a real
# deadline for the whole call; on timeout the child is killed and a partial OutFile removed.
function Invoke-NativeCapture {
    param([string]$FilePath, [string]$Arguments, [string]$OutFile, [int]$TimeoutSec = 180)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables['GH_PROMPT_DISABLED'] = '1'
    $psi.EnvironmentVariables['GH_NO_UPDATE_NOTIFIER'] = '1'
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    $p = [System.Diagnostics.Process]::Start($psi)
    $fs = $null
    $timedOut = $false
    try {
        $errTask = $p.StandardError.ReadToEndAsync()
        if ($OutFile) {
            $fs = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $outTask = $p.StandardOutput.BaseStream.CopyToAsync($fs)
        } else {
            $outTask = $p.StandardOutput.ReadToEndAsync()
        }
        $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        $done = $p.WaitForExit($left)
        if ($done) {
            $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
            $done = [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($outTask, $errTask), $left)
        }
        if (-not $done) {
            $timedOut = $true
            Stop-OwnedProcess $p
            try { [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($outTask, $errTask), 5000) } catch { }
        }
        if (-not $timedOut) {
            $out = ''
            if (-not $OutFile) { $out = $outTask.Result }
            return [pscustomobject]@{ ExitCode = $p.ExitCode; Stdout = $out; Stderr = $errTask.Result }
        }
    } finally {
        if ($fs) { $fs.Dispose() }
        $p.Dispose()
    }
    if ($OutFile) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
    Stop-Updater "外部コマンドが ${TimeoutSec}秒でタイムアウトしたため終了しました: $([System.IO.Path]::GetFileName($FilePath))" 1
}

function Get-GhPath {
    param([string]$GhPath)
    $cmd = Get-Command -Name $GhPath -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { Stop-Updater 'gh CLI が見つかりません。インストールして `gh auth login` を手動で済ませてください（本scriptは自動loginしません）。' 2 }
    return $cmd.Source
}

function Assert-GhReady {
    param([string]$GhPath = 'gh')
    $exe = Get-GhPath $GhPath
    $r = Invoke-NativeCapture -FilePath $exe -Arguments 'auth status' -TimeoutSec 60
    if ($r.ExitCode -ne 0) { Stop-Updater 'gh が未認証です。手動で `gh auth login` を実行してください（本scriptは自動loginしません）。' 2 }
}

function Get-GhJson {
    param([string]$Endpoint, [string]$GhPath = 'gh')
    $exe = Get-GhPath $GhPath
    $r = Invoke-NativeCapture -FilePath $exe -Arguments "api $Endpoint" -TimeoutSec 120
    if ($r.ExitCode -ne 0) { Stop-Updater "gh api に失敗しました ($Endpoint): $(Hide-Secrets $r.Stderr)" 2 }
    try { return ($r.Stdout | ConvertFrom-Json) } catch { Stop-Updater "gh api の応答を解析できません ($Endpoint)" 2 }
}

function Save-GhArtifactZip {
    param([string]$Repository, [string]$ArtifactId, [string]$OutFile, [string]$GhPath = 'gh')
    $exe = Get-GhPath $GhPath
    $r = Invoke-NativeCapture -FilePath $exe -Arguments "api repos/$Repository/actions/artifacts/$ArtifactId/zip" -OutFile $OutFile -TimeoutSec 300
    if ($r.ExitCode -ne 0) { Stop-Updater "artifact のダウンロードに失敗しました: $(Hide-Secrets $r.Stderr)" 2 }
}

# ---------- run / artifact verification (pure; no silent fallback) ----------

function Assert-RunVerified {
    param($Run, [string]$RunId, [string]$ExpectedCommit, [string]$Repository, [string]$ExpectedBranch, [string]$ExpectedWorkflowId)
    if ([string](Get-Prop $Run 'id') -ne $RunId) { Stop-Updater "run ID が一致しません (期待 $RunId)" 2 }
    if ((Get-Prop $Run 'status') -ne 'completed') { Stop-Updater "run $RunId は completed ではありません (status=$(Get-Prop $Run 'status'))" 2 }
    if ((Get-Prop $Run 'conclusion') -ne 'success') { Stop-Updater "run $RunId は success ではありません (conclusion=$(Get-Prop $Run 'conclusion'))" 2 }
    $sha = [string](Get-Prop $Run 'head_sha')
    if ($sha.ToLowerInvariant() -ne $ExpectedCommit) { Stop-Updater "run $RunId の head SHA が ExpectedCommit と異なります (run=$sha)" 2 }
    $repo = Get-Prop (Get-Prop $Run 'repository') 'full_name'
    $headRepo = Get-Prop (Get-Prop $Run 'head_repository') 'full_name'
    if ([string]$repo -ine $Repository) { Stop-Updater "run の repository が異なります ($repo)" 2 }
    if ([string]$headRepo -ine $Repository) { Stop-Updater "run の head repository が異なります（forkは不可: $headRepo）" 2 }
    if ((Get-Prop $Run 'head_branch') -cne $ExpectedBranch) { Stop-Updater "run の branch が異なります ($(Get-Prop $Run 'head_branch'), 期待 $ExpectedBranch)" 2 }
    $event = Get-Prop $Run 'event'
    if ($event -ne 'push' -and $event -ne 'workflow_dispatch') { Stop-Updater "run の event が許可外です ($event)" 2 }
    # Exact match only. The one supported suffix form is "@refs/heads/<ExpectedBranch>", validated explicitly.
    $wfPath = [string](Get-Prop $Run 'path')
    if ($wfPath -cne $script:WorkflowFile -and $wfPath -cne "$($script:WorkflowFile)@refs/heads/$ExpectedBranch") {
        Stop-Updater "run のworkflowが $($script:WorkflowFile) ではありません ($wfPath)" 2
    }
    if ($ExpectedWorkflowId) {
        if ($ExpectedWorkflowId -notmatch '^\d+$') { Stop-Updater 'ExpectedWorkflowId は数字のみで指定してください' 2 }
        if ([string](Get-Prop $Run 'workflow_id') -ne $ExpectedWorkflowId) { Stop-Updater "run の workflow_id が ExpectedWorkflowId と異なります ($(Get-Prop $Run 'workflow_id'))" 2 }
    }
}

function Select-BundleArtifact {
    param($List, [string]$RunId, [string]$ExpectedCommit)
    $name = "vault-gantt-faroe-$ExpectedCommit"
    $hits = @(@(Get-Prop $List 'artifacts') | Where-Object { (Get-Prop $_ 'name') -ceq $name })
    if ($hits.Count -ne 1) { Stop-Updater "artifact $name が run $RunId にちょうど1件ありません (件数=$($hits.Count))" 2 }
    $a = $hits[0]
    if ((Get-Prop $a 'expired') -eq $true) { Stop-Updater "artifact $name は期限切れです" 2 }
    if ([string](Get-Prop $a 'id') -notmatch '^\d+$') { Stop-Updater 'artifact ID が不正です' 2 }
    $wr = Get-Prop $a 'workflow_run'
    if ([string](Get-Prop $wr 'id') -ne $RunId -or ([string](Get-Prop $wr 'head_sha')).ToLowerInvariant() -ne $ExpectedCommit) {
        Stop-Updater "artifact $name のrun/commitが一致しません" 2
    }
    $size = [int64](Get-Prop $a 'size_in_bytes')
    if ($size -le 0 -or $size -gt 32MB) { Stop-Updater "artifact のサイズが想定外です ($size bytes)" 2 }
    return $a
}

# ---------- zip validation / extraction ----------

function Assert-BundleZip {
    param([string]$ZipPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $allowed = @($script:PayloadFiles + $script:MetaFiles)
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $seen = @{}
        foreach ($e in $zip.Entries) {
            $n = $e.FullName
            if ($n.StartsWith('/') -or $n.StartsWith('\') -or $n -match '^[A-Za-z]:' -or [System.IO.Path]::IsPathRooted($n)) { Stop-Updater "zip に絶対パスのentryがあります: $n" 2 }
            if ($n -match '(^|[\\/])\.\.([\\/]|$)') { Stop-Updater "zip に .. を含むentryがあります: $n" 2 }
            if ($n.Contains('/') -or $n.Contains('\') -or $n.Contains(':')) { Stop-Updater "zip にサブディレクトリ/不正文字を含むentryがあります: $n" 2 }
            if ($allowed -cnotcontains $n) { Stop-Updater "zip に許可リスト外のentryがあります: $n" 2 }
            if ($seen.ContainsKey($n)) { Stop-Updater "zip にentryの重複があります: $n" 2 }
            $seen[$n] = $true
            $attr = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$e.ExternalAttributes), 0)
            $unixType = ($attr -shr 16) -band 0xF000
            if ($unixType -ne 0 -and $unixType -ne 0x8000) { Stop-Updater "zip のentryが通常ファイルではありません (symlink等): $n" 2 }
            if (($attr -band 0x400) -ne 0 -or ($attr -band 0x10) -ne 0) { Stop-Updater "zip のentryがreparse point/ディレクトリ属性です: $n" 2 }
            if ($e.Length -gt $script:MaxEntryBytes) { Stop-Updater "zip のentryが大きすぎます: $n" 2 }
        }
        foreach ($n in $allowed) {
            if (-not $seen.ContainsKey($n)) { Stop-Updater "zip に必要なentryがありません: $n" 2 }
        }
    } finally { $zip.Dispose() }
}

function Expand-BundleZip {
    param([string]$ZipPath, [string]$DestDir)
    Assert-BundleZip $ZipPath
    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($e in $zip.Entries) {
            $target = Join-Path $DestDir $e.FullName
            if (-not (Test-PathUnder $target $DestDir)) { Stop-Updater "展開先がstaging外です: $($e.FullName)" 2 }
            $in = $e.Open()
            $out = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            try {
                $buf = New-Object byte[] 65536
                $total = [int64]0
                while (($r = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                    $total += $r
                    if ($total -gt $e.Length) { Stop-Updater "entry の実サイズが宣言を超えました: $($e.FullName)" 2 }
                    $out.Write($buf, 0, $r)
                }
            } finally { $out.Dispose(); $in.Dispose() }
        }
    } finally { $zip.Dispose() }
    Assert-NoLinkChain -Path $DestDir -Root $DestDir -What 'staging' -Strict
    foreach ($f in (Get-ChildItem -LiteralPath $DestDir -Force)) {
        if ($f.PSIsContainer -or (Test-IsLink -Path $f.FullName -Strict)) { Stop-Updater "展開結果に不正なentryがあります: $($f.Name)" 2 }
        if (-not (Test-PathUnder $f.FullName $DestDir)) { Stop-Updater "展開結果がstaging外です: $($f.Name)" 2 }
    }
}

function Assert-BundleContent {
    param([string]$Dir, [string]$RunId, [string]$ExpectedCommit, [string]$Repository, [string]$Ref, [string]$RunAttempt)
    $meta = Read-JsonFile (Join-Path $Dir 'metadata.json') 'metadata.json'
    if ((Get-Prop $meta 'schema') -ne 1) { Stop-Updater 'metadata の schema が未対応です' 2 }
    if ([string](Get-Prop $meta 'commit') -ne $ExpectedCommit) { Stop-Updater 'metadata の commit が ExpectedCommit と異なります' 2 }
    if ([string](Get-Prop $meta 'runId') -ne $RunId) { Stop-Updater 'metadata の runId が RunId と異なります' 2 }
    if ([string](Get-Prop $meta 'repository') -ine $Repository) { Stop-Updater 'metadata の repository が異なります' 2 }
    if ([string](Get-Prop $meta 'ref') -cne $Ref) { Stop-Updater 'metadata の ref が検証済みrunのbranchと異なります' 2 }
    if ($RunAttempt -notmatch '^\d+$' -or [string](Get-Prop $meta 'runAttempt') -cne $RunAttempt) { Stop-Updater 'metadata の runAttempt が検証済みrunのrun_attemptと異なります' 2 }
    if ((Get-Prop $meta 'manifestId') -cne $script:PluginId) { Stop-Updater "metadata の manifestId が $($script:PluginId) ではありません" 2 }
    $files = Get-Prop $meta 'files'
    $keys = @($files.PSObject.Properties.Name)
    if ($keys.Count -ne 3) { Stop-Updater 'metadata.files が3ファイルではありません' 2 }

    $sums = @{}
    foreach ($line in (Get-Content -LiteralPath (Join-Path $Dir 'SHA256SUMS') -Encoding UTF8)) {
        if ($line.Trim() -eq '') { continue }
        if ($line -cnotmatch '^([0-9a-f]{64})  (main\.js|manifest\.json|styles\.css)$') { Stop-Updater "SHA256SUMS の形式が不正です: $line" 2 }
        if ($sums.ContainsKey($Matches[2])) { Stop-Updater 'SHA256SUMS に重複があります' 2 }
        $sums[$Matches[2]] = $Matches[1]
    }
    if ($sums.Count -ne 3) { Stop-Updater 'SHA256SUMS が3ファイル分ありません' 2 }

    $result = @{}
    foreach ($n in $script:PayloadFiles) {
        $m = Get-Prop $files $n
        if ($null -eq $m) { Stop-Updater "metadata.files に $n がありません" 2 }
        $path = Join-Path $Dir $n
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Stop-Updater "$n がありません" 2 }
        $size = (Get-Item -LiteralPath $path).Length
        if ($size -le 0 -or $size -ne [int64](Get-Prop $m 'size')) { Stop-Updater "$n のサイズが不正/metadataと不一致です" 2 }
        $hash = Get-Sha256 $path
        if ($hash -cne [string](Get-Prop $m 'sha256')) { Stop-Updater "$n のSHA256がmetadataと一致しません" 2 }
        if ($hash -cne $sums[$n]) { Stop-Updater "$n のSHA256がSHA256SUMSと一致しません" 2 }
        $result[$n] = [pscustomobject]@{ Sha256 = $hash; Size = $size }
    }
    $manifest = Read-JsonFile (Join-Path $Dir 'manifest.json') 'manifest.json'
    if ((Get-Prop $manifest 'id') -cne $script:PluginId) { Stop-Updater "manifest.json の id が $($script:PluginId) ではありません" 2 }
    if ([string](Get-Prop $manifest 'version') -ne [string](Get-Prop $meta 'manifestVersion')) { Stop-Updater 'manifest.json の version がmetadataと一致しません' 2 }
    return $result
}

# ---------- vault / work root ----------

function Resolve-WorkRoot {
    param([string]$WorkRoot, [string]$VaultPath)
    if (-not $WorkRoot) { $WorkRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'vault-gantt-faroe' }
    $w = Get-NormPath $WorkRoot
    if (Test-PathUnder $w $VaultPath) { Stop-Updater "WorkRoot がVault内です: $w" 2 }
    if (Test-PathUnder $VaultPath $w) { Stop-Updater 'WorkRoot がVaultを含んでいます' 2 }
    if (Test-InOneDrive $w) { Stop-Updater "WorkRoot がOneDrive配下です。-WorkRoot でOneDrive外を指定してください: $w" 2 }
    # Check every ancestor up to the drive root: a link in a parent could redirect staging/backups into the Vault/OneDrive.
    # Checked before creating anything (missing components are skipped), and again after.
    $driveRoot = [System.IO.Path]::GetPathRoot($w)
    Assert-NoLinkChain -Path $w -Root $driveRoot -What 'WorkRoot' -Strict
    if (-not (Test-Path -LiteralPath $w)) { New-Item -ItemType Directory -Path $w -Force | Out-Null }
    Assert-NoLinkChain -Path $w -Root $driveRoot -What 'WorkRoot' -Strict
    return $w
}

function Resolve-PluginDir {
    param([string]$VaultPath)
    if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) { Stop-Updater "Vaultが存在しません: $VaultPath" 2 }
    $vault = Get-NormPath $VaultPath
    $plugin = Join-Path $vault '.obsidian\plugins\vault-gantt'
    if (-not (Test-Path -LiteralPath (Join-Path $vault '.obsidian') -PathType Container)) { Stop-Updater 'Vault直下に .obsidian がありません（Vaultのルートを指定してください）' 2 }
    if (-not (Test-Path -LiteralPath $plugin -PathType Container)) {
        Stop-Updater "プラグインフォルダーがありません: $plugin （初回導入はREADMEの手順で手動作成してください）" 2
    }
    # Every ancestor up to the drive root (Vault root and its parents included): a link anywhere above
    # could redirect the writes or defeat the OneDrive/containment checks.
    Assert-NoLinkChain -Path $plugin -Root ([System.IO.Path]::GetPathRoot($vault)) -What 'Vault/プラグインフォルダー'
    if (-not (Test-PathUnder $plugin $vault)) { Stop-Updater 'プラグインフォルダーがVault外です' 2 }
    return $plugin
}

function Get-TargetState {
    param([string]$PluginDir)
    $state = @{}
    foreach ($n in $script:PayloadFiles) {
        $p = Join-Path $PluginDir $n
        if (Test-Path -LiteralPath $p) {
            if (-not (Test-Path -LiteralPath $p -PathType Leaf) -or (Test-IsUnsafeTargetFile (Get-Item -LiteralPath $p -Force))) { Stop-Updater "$n が通常ファイルではありません: $p" 2 }
            $state[$n] = [pscustomobject]@{ Existed = $true; Sha256 = (Get-Sha256 $p); Size = (Get-Item -LiteralPath $p).Length }
        } else {
            $state[$n] = [pscustomobject]@{ Existed = $false; Sha256 = $null; Size = 0 }
        }
    }
    return $state
}

function Get-UserDataSnapshot {
    param([string]$PluginDir)
    $p = Join-Path $PluginDir 'data.json'
    if (Test-Path -LiteralPath $p) { return (Get-Sha256 $p) }
    return $null
}

function Get-EnabledPluginIds {
    param([string]$VaultPath)
    $f = Join-Path $VaultPath '.obsidian\community-plugins.json'
    if (-not (Test-Path -LiteralPath $f)) { return @() }
    $j = Read-JsonFile $f 'community-plugins.json'
    return @($j | ForEach-Object { [string]$_ })
}

function Get-SyncRisk {
    param([string]$VaultPath)
    $reasons = @()
    if (Test-InOneDrive $VaultPath) { $reasons += 'VaultがOneDrive配下にあります' }
    $enabled = Get-EnabledPluginIds $VaultPath
    foreach ($id in $script:SyncPluginIds) {
        if ((Test-Path -LiteralPath (Join-Path $VaultPath ".obsidian\plugins\$id")) -or ($enabled -contains $id)) {
            $reasons += "同期系プラグイン $id が導入されています"
        }
    }
    $core = Join-Path $VaultPath '.obsidian\core-plugins.json'
    if (Test-Path -LiteralPath $core) {
        try {
            $c = Get-Content -LiteralPath $core -Raw -Encoding UTF8 | ConvertFrom-Json
            if ((Get-Prop $c 'sync') -eq $true) { $reasons += 'Obsidian Sync(コアプラグイン)が有効です' }
        } catch { $reasons += 'core-plugins.json を解析できません' }
    }
    return $reasons
}

function Assert-SyncGate {
    param([string]$VaultPath, [switch]$AllowSyncedVault, [switch]$SyncPausedConfirmed)
    $risk = @(Get-SyncRisk $VaultPath)
    if ($risk.Count -eq 0) { return }
    foreach ($r in $risk) { Write-Info "同期リスク: $r" }
    if (-not ($AllowSyncedVault -and $SyncPausedConfirmed)) {
        Stop-Updater '同期されるVaultへの書き込みは既定で拒否されます。専用のunsynced preview Vaultを使うか、同期を停止した上で -AllowSyncedVault -SyncPausedConfirmed を両方指定してください（tools/faroe/README.md参照）。' 4
    }
    Write-Info '同期Vaultへの適用が明示的に許可されています（同期停止は利用者の責任で確認済みとして扱います）。'
}

# ---------- Obsidian CLI (opt-in, verified, fails safe) ----------

function Get-CliArgs {
    param([string]$VaultName, [string]$Command)
    return "vault=`"$VaultName`" $Command"
}

# Returns the resolved CLI path only if help lists the needed commands AND the
# named vault resolves to exactly VaultPath. Otherwise $null (caller safe-stops).
function Resolve-ObsidianCli {
    param([string]$CliPath, [string]$VaultName, [string]$VaultPath)
    if (-not $VaultName -or $VaultName -notmatch '^[^"\r\n]+$') { return $null }
    $cmd = Get-Command -Name $CliPath -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { return $null }
    try {
        $help = Invoke-NativeCapture -FilePath $cmd.Source -Arguments 'help' -TimeoutSec 30
        if ($help.ExitCode -ne 0) { return $null }
        foreach ($tok in 'plugin:enable', 'plugin:disable', 'vault=') {
            if (-not $help.Stdout.Contains($tok)) { return $null }
        }
        $info = Invoke-NativeCapture -FilePath $cmd.Source -Arguments (Get-CliArgs $VaultName 'vault info=path') -TimeoutSec 30
        if ($info.ExitCode -ne 0) { return $null }
        $reported = $info.Stdout.Trim()
        if (-not $reported -or $reported.Contains("`n")) { return $null }
        if (-not (Get-NormPath $reported).Equals((Get-NormPath $VaultPath), [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    } catch { return $null }
    return $cmd.Source
}

function Write-GuiSteps {
    Write-Info '--- 手動手順（GUI）---'
    Write-Info '1. Obsidianで 設定 → コミュニティプラグイン → 「Vault Gantt」をオフにする'
    Write-Info '2. 本scriptを同じ引数で再実行する'
    Write-Info '3. 完了後、同じ画面で「Vault Gantt」をオンに戻す'
}

function Set-PluginViaCli {
    param([string]$Cli, [string]$VaultName, [ValidateSet('enable', 'disable')][string]$Action)
    try {
        $r = Invoke-NativeCapture -FilePath $Cli -Arguments (Get-CliArgs $VaultName "plugin:$Action id=$($script:PluginId)") -TimeoutSec 60
        return ($r.ExitCode -eq 0)
    } catch { return $false }  # timeout/launch failure must not mask the caller's outcome
}

# ---------- atomic-ish install / rollback ----------

function Install-Files {
    param([string]$SourceDir, [string]$PluginDir, [hashtable]$Expected)
    $staged = @{}
    try {
        foreach ($n in $script:PayloadFiles) {
            $t = Join-Path $PluginDir ".$n.vg-new-$([guid]::NewGuid().ToString('N'))"
            [System.IO.File]::Copy((Join-Path $SourceDir $n), $t, $false)
            $staged[$n] = $t
            if ((Get-Sha256 $t) -cne $Expected[$n]) { throw "stagedファイルのhash不一致: $n" }
        }
        # manifest.json last so the version flips only after main.js/styles.css are in place
        foreach ($n in @('main.js', 'styles.css', 'manifest.json')) {
            $dest = Join-Path $PluginDir $n
            if (Test-Path -LiteralPath $dest) {
                [System.IO.File]::Replace($staged[$n], $dest, [NullString]::Value)
            } else {
                [System.IO.File]::Move($staged[$n], $dest)
            }
            $staged.Remove($n)
        }
    } finally {
        foreach ($t in $staged.Values) { Remove-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue }
    }
}

# Full ancestor/reparse validation of everything a restore reads or writes: WorkRoot, BackupDir
# (up to the drive root), the backup tree contents, the Vault and the target plugin path.
# Run when validating a rollback AND again right before each file is restored (time of use).
function Assert-RestorePaths {
    param([string]$BackupDir, [string]$WorkRoot, [string]$PluginDir)
    $bdir = Get-NormPath $BackupDir
    $work = Get-NormPath $WorkRoot
    if (-not (Test-PathUnder $bdir $work) -or $bdir.Equals($work, [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Updater "BackupDir がWorkRoot配下ではありません: $bdir" 2 }
    if (-not (Test-Path -LiteralPath $bdir -PathType Container)) { Stop-Updater "BackupDir が存在しません: $bdir" 2 }
    Assert-NoLinkChain -Path $bdir -Root ([System.IO.Path]::GetPathRoot($bdir)) -What 'WorkRoot/BackupDir' -Strict
    $plugin = Get-NormPath $PluginDir
    Assert-NoLinkChain -Path $plugin -Root ([System.IO.Path]::GetPathRoot($plugin)) -What 'Vault/プラグインフォルダー'
    $top = @(Get-ChildItem -LiteralPath $bdir -Force | ForEach-Object { $_.Name })
    foreach ($n in $top) { if ($n -cne 'backup.json' -and $n -cne 'files') { Stop-Updater "backup に想定外のentryがあります: $n" 2 } }
    $bj = Join-Path $bdir 'backup.json'
    if (-not (Test-Path -LiteralPath $bj -PathType Leaf) -or (Test-IsLink -Path $bj -Strict)) { Stop-Updater 'backup.json が不正です（存在しない/リンク）' 2 }
    $fd = Join-Path $bdir 'files'
    if (-not (Test-Path -LiteralPath $fd -PathType Container) -or (Test-IsLink -Path $fd -Strict)) { Stop-Updater 'backup の files フォルダーが不正です（存在しない/リンク）' 2 }
    foreach ($f in @(Get-ChildItem -LiteralPath $fd -Force)) {
        if ($script:PayloadFiles -cnotcontains $f.Name) { Stop-Updater "backup の files に想定外のentryがあります: $($f.Name)" 2 }
        if ($f.PSIsContainer -or (Test-IsLink -Path $f.FullName -Strict) -or -not (Test-PathUnder $f.FullName $fd)) { Stop-Updater "backup のファイルが不正です（リンク/ディレクトリ）: $($f.Name)" 2 }
    }
}

# Restores the three files from backup. Returns $true when every file ends in its backed-up state.
function Restore-FromBackup {
    param([string]$BackupDir, [string]$PluginDir, $BackupMeta, [string]$WorkRoot)
    $ok = $true
    foreach ($n in $script:PayloadFiles) {
        $b = Get-Prop $BackupMeta.files $n
        $dest = Join-Path $PluginDir $n
        try {
            Assert-RestorePaths -BackupDir $BackupDir -WorkRoot $WorkRoot -PluginDir $PluginDir
            if ((Test-Path -LiteralPath $dest) -and (Test-IsUnsafeTargetFile (Get-Item -LiteralPath $dest -Force))) { throw "復元先が不正です: $n" }
            if ($b.existed) {
                $src = Join-Path $BackupDir "files\$n"
                if ((Get-Sha256 $src) -cne $b.sha256) { throw "backupファイルが破損しています: $n" }
                $cur = $null
                if (Test-Path -LiteralPath $dest) { $cur = Get-Sha256 $dest }
                if ($cur -cne $b.sha256) {
                    $t = Join-Path $PluginDir ".$n.vg-restore-$([guid]::NewGuid().ToString('N'))"
                    [System.IO.File]::Copy($src, $t, $false)
                    try {
                        if (Test-Path -LiteralPath $dest) { [System.IO.File]::Replace($t, $dest, [NullString]::Value) } else { [System.IO.File]::Move($t, $dest) }
                    } finally { Remove-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue }
                }
                if ((Get-Sha256 $dest) -cne $b.sha256) { throw 'restore後のhashが不一致' }
            } else {
                if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
            }
        } catch {
            $ok = $false
            Write-Info "rollback失敗 ($n): $(Hide-Secrets $_.Exception.Message)"
        }
    }
    return $ok
}

function New-Backup {
    param([string]$WorkRoot, [string]$VaultPath, [string]$PluginDir, $State, [string]$Commit, [string]$RunId, [string]$Repository, $NewFiles)
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $dir = Join-Path $WorkRoot "backup-$stamp-$($Commit.Substring(0, 8))-$([guid]::NewGuid().ToString('N').Substring(0, 6))"
    New-Item -ItemType Directory -Path (Join-Path $dir 'files') -Force | Out-Null
    $files = [ordered]@{}
    foreach ($n in $script:PayloadFiles) {
        $s = $State[$n]
        if ($s.Existed) { Copy-Item -LiteralPath (Join-Path $PluginDir $n) -Destination (Join-Path $dir "files\$n") }
        $files[$n] = [ordered]@{ existed = $s.Existed; sha256 = $s.Sha256; size = $s.Size }
        if ($s.Existed -and (Get-Sha256 (Join-Path $dir "files\$n")) -cne $s.Sha256) { Stop-Updater "backupの検証に失敗しました: $n" 1 }
    }
    $new = [ordered]@{}
    foreach ($n in $script:PayloadFiles) { $new[$n] = $NewFiles[$n].Sha256 }
    $meta = [ordered]@{
        schema = 1; createdUtc = $stamp; vaultPath = (Get-NormPath $VaultPath); pluginDir = (Get-NormPath $PluginDir)
        commit = $Commit; runId = $RunId; repository = $Repository; files = $files; newSha256 = $new
    }
    $json = $meta | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText((Join-Path $dir 'backup.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
    return $dir
}

function Format-StateLine {
    param([string]$Name, $Cur, $New)
    $c = '(なし)'
    if ($Cur.Existed) { $c = $Cur.Sha256.Substring(0, 12) }
    $mark = '変更あり'
    if ($Cur.Existed -and $Cur.Sha256 -ceq $New.Sha256) { $mark = '同一' }
    return "  $Name : $c -> $($New.Sha256.Substring(0, 12)) ($($New.Size) bytes) [$mark]"
}

# Full validation of the three payload files on disk against Expect (name -> {Sha256, Size}):
# regular file, size, SHA256, and manifest.json id. $false on any problem.
function Test-InstalledBundle {
    param([string]$PluginDir, $Expect)
    if ($null -eq $Expect) { return $false }
    try {
        foreach ($n in $script:PayloadFiles) {
            $p = Join-Path $PluginDir $n
            if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $false }
            $item = Get-Item -LiteralPath $p -Force
            if (Test-IsUnsafeTargetFile $item) { return $false }
            if ($item.Length -ne [int64]$Expect[$n].Size) { return $false }
            if ((Get-Sha256 $p) -cne [string]$Expect[$n].Sha256) { return $false }
        }
        $m = Get-Content -LiteralPath (Join-Path $PluginDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        return ((Get-Prop $m 'id') -ceq $script:PluginId)
    } catch { return $false }
}

# Expected state of the backed-up (old) bundle; $null if any file did not exist then.
function Get-BackupExpect {
    param($BackupMeta)
    $e = @{}
    foreach ($n in $script:PayloadFiles) {
        $b = Get-Prop $BackupMeta.files $n
        if ($null -eq $b -or -not $b.existed) { return $null }
        $e[$n] = [pscustomobject]@{ Sha256 = [string]$b.sha256; Size = [int64]$b.size }
    }
    return $e
}

# Shared by update and rollback: plugin-enabled handling. Returns a session; the caller sets
# Verified only after the 3-file bundle (new or restored old) passed Test-InstalledBundle.
function Enter-PluginQuiesce {
    param([string]$VaultPath, [switch]$UseObsidianCli, [string]$ObsidianCliVaultName, [string]$ObsidianCliPath = 'obsidian')
    $session = @{ VaultPath = $VaultPath; Cli = $null; VaultName = $ObsidianCliVaultName; WasEnabled = $false; Verified = $false }
    if ((Get-EnabledPluginIds $VaultPath) -notcontains $script:PluginId) { return $session }
    $session.WasEnabled = $true
    if (-not $UseObsidianCli) {
        Write-Info 'プラグインが有効なため書き換えずに停止します。'
        Write-GuiSteps
        Stop-Updater 'プラグインを無効化してから再実行してください。' 3
    }
    $cli = Resolve-ObsidianCli -CliPath $ObsidianCliPath -VaultName $ObsidianCliVaultName -VaultPath $VaultPath
    if (-not $cli) {
        Write-Info 'Obsidian CLIが未有効、またはコマンド形式/対象Vaultを検証できませんでした。何も変更していません。'
        Write-GuiSteps
        Stop-Updater 'Obsidian CLIを安全に使えません。' 3
    }
    if (-not (Set-PluginViaCli -Cli $cli -VaultName $ObsidianCliVaultName -Action disable)) {
        Write-GuiSteps
        Stop-Updater 'CLIでのプラグイン無効化に失敗しました。何も変更していません。' 3
    }
    for ($i = 0; $i -lt 10; $i++) {
        if ((Get-EnabledPluginIds $VaultPath) -notcontains $script:PluginId) { break }
        Start-Sleep -Milliseconds 500
    }
    if ((Get-EnabledPluginIds $VaultPath) -contains $script:PluginId) {
        Set-PluginViaCli -Cli $cli -VaultName $ObsidianCliVaultName -Action enable | Out-Null
        Write-GuiSteps
        Stop-Updater '無効化を確認できませんでした。何も変更していません。' 3
    }
    $session.Cli = $cli
    return $session
}

# Returns $false only when a CLI re-enable was attempted but the plugin is not confirmed enabled.
function Exit-PluginQuiesce {
    param($Session)
    if (-not $Session.Verified) {
        if ($Session.WasEnabled) {
            Write-Info '3ファイルの検証が完了していないため、プラグインは無効のままにします（再有効化しません）。'
            Write-Info 'backupの files フォルダーから3ファイルを手動で復元し、hashを確認してからGUIで有効化してください。'
        }
        return $true
    }
    if (-not $Session.WasEnabled) { Write-Info 'プラグインの有効/無効状態は変更していません。'; return $true }
    if ($Session.Cli) {
        $enabled = $false
        if (Set-PluginViaCli -Cli $Session.Cli -VaultName $Session.VaultName -Action enable) {
            for ($i = 0; $i -lt 10 -and -not $enabled; $i++) {
                $enabled = ((Get-EnabledPluginIds $Session.VaultPath) -contains $script:PluginId)
                if (-not $enabled) { Start-Sleep -Milliseconds 500 }
            }
            if ($enabled) { Write-Info 'CLIでプラグインを再有効化し、有効状態を確認しました。'; return $true }
            Write-Info '【要手動対応】CLIはenableに成功を返しましたが、有効状態を確認できませんでした。'
        } else {
            Write-Info '【要手動対応】CLIでの再有効化に失敗しました。'
        }
        Write-Info '3ファイルは検証済みです。Obsidianの 設定 → コミュニティプラグイン で「Vault Gantt」の状態を確認し、オフならオンにしてください。'
        return $false
    }
    Write-Info 'Obsidianの 設定 → コミュニティプラグイン で「Vault Gantt」をオンにしてください。'
    return $true
}

# ---------- Vault-scoped mutual exclusion ----------

# One named mutex per canonical Vault path covers the whole apply/rollback transaction
# (plugin disable, backup, 3-file writes, verification, enable). Fails fast when busy.
function Enter-VaultLock {
    param([string]$VaultPath)
    $canon = (Get-NormPath $VaultPath).ToLowerInvariant()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hex = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canon))).Replace('-', '')
    $created = $false
    $m = New-Object System.Threading.Mutex($false, "Global\VaultGanttUpdater-$($hex.Substring(0, 32))", [ref]$created)
    $got = $false
    try {
        $got = $m.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $got = $true
        Write-Info '警告: 前回のupdate/rollbackが異常終了した可能性があります。backupとVaultの状態を確認してください。'
    }
    if (-not $got) {
        $m.Dispose()
        Stop-Updater 'このVaultに対して別のupdate/rollbackが実行中です。完了後に再実行してください（何も変更していません）。' 6
    }
    return $m
}

function Exit-VaultLock {
    param($Mutex)
    try { $Mutex.ReleaseMutex() } catch { }
    $Mutex.Dispose()
}

# ---------- entry points ----------

function Invoke-VaultGanttUpdate {
    [CmdletBinding()]
    param(
        [string]$RunId, [string]$ExpectedCommit, [string]$Repository, [string]$ExpectedBranch = 'main', [string]$ExpectedWorkflowId, [string]$VaultPath,
        [switch]$Apply, [switch]$AllowSyncedVault, [switch]$SyncPausedConfirmed,
        [switch]$UseObsidianCli, [string]$ObsidianCliVaultName, [string]$ObsidianCliPath = 'obsidian',
        [string]$WorkRoot, [string]$GhPath = 'gh'
    )
    if ($RunId -notmatch '^\d+$') { Stop-Updater 'RunId は数字のみで指定してください' 2 }
    if ($ExpectedCommit -cnotmatch '^[0-9a-f]{40}$') { Stop-Updater 'ExpectedCommit は40桁の小文字hex(full SHA)で指定してください' 2 }
    if ($Repository -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') { Stop-Updater 'Repository は owner/name 形式で指定してください' 2 }
    if (-not $ExpectedBranch -or $ExpectedBranch -notmatch '^[A-Za-z0-9._/-]+$') { Stop-Updater 'ExpectedBranch が不正です' 2 }
    if (-not $VaultPath) { Stop-Updater 'VaultPath が必要です' 2 }

    $vault = Get-NormPath $VaultPath
    $plugin = Resolve-PluginDir $vault
    $work = Resolve-WorkRoot $WorkRoot $vault
    $stage = Join-Path $work "stage-$([guid]::NewGuid().ToString('N'))"
    try {
        Assert-GhReady -GhPath $GhPath
        $run = Get-GhJson -Endpoint "repos/$Repository/actions/runs/$RunId" -GhPath $GhPath
        Assert-RunVerified -Run $run -RunId $RunId -ExpectedCommit $ExpectedCommit -Repository $Repository -ExpectedBranch $ExpectedBranch -ExpectedWorkflowId $ExpectedWorkflowId
        Write-Info "run $RunId を確認しました (success / $ExpectedBranch / $($ExpectedCommit.Substring(0, 12)))"
        $list = Get-GhJson -Endpoint "repos/$Repository/actions/runs/$RunId/artifacts?per_page=100" -GhPath $GhPath
        $art = Select-BundleArtifact -List $list -RunId $RunId -ExpectedCommit $ExpectedCommit

        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        $zip = Join-Path $stage 'artifact.zip'
        Save-GhArtifactZip -Repository $Repository -ArtifactId ([string](Get-Prop $art 'id')) -OutFile $zip -GhPath $GhPath
        $digest = [string](Get-Prop $art 'digest')
        if ($digest -match '^sha256:([0-9a-fA-F]{64})$') {
            if ((Get-Sha256 $zip) -cne $Matches[1].ToLowerInvariant()) { Stop-Updater 'artifact zip のdigestが一致しません' 2 }
        }
        $extract = Join-Path $stage 'extract'
        Expand-BundleZip -ZipPath $zip -DestDir $extract
        $newFiles = Assert-BundleContent -Dir $extract -RunId $RunId -ExpectedCommit $ExpectedCommit -Repository $Repository -Ref ([string](Get-Prop $run 'head_branch')) -RunAttempt ([string](Get-Prop $run 'run_attempt'))
        Write-Info 'artifact の検証に成功しました（allowlist / metadata / SHA256）。'

        $state = Get-TargetState $plugin
        Write-Info "対象: $plugin"
        foreach ($n in $script:PayloadFiles) { Write-Info (Format-StateLine $n $state[$n] $newFiles[$n]) }
        foreach ($r in @(Get-SyncRisk $vault)) { Write-Info "同期リスク: $r" }

        if (-not $Apply) {
            Write-Info 'DRY-RUN: Vaultは変更していません。実更新は -Apply を付けて再実行してください。'
            return [pscustomobject]@{ Mode = 'DryRun'; BackupDir = $null }
        }

        $lock = Enter-VaultLock $vault
        try {
            Assert-SyncGate -VaultPath $vault -AllowSyncedVault:$AllowSyncedVault -SyncPausedConfirmed:$SyncPausedConfirmed
            $session = Enter-PluginQuiesce -VaultPath $vault -UseObsidianCli:$UseObsidianCli -ObsidianCliVaultName $ObsidianCliVaultName -ObsidianCliPath $ObsidianCliPath
            # Baselines are taken under the lock and only after the plugin is disabled, so Obsidian's own
            # settings writes during unload are not mistaken for a mutation.
            $state = Get-TargetState $plugin
            $dataBefore = Get-UserDataSnapshot $plugin
            $backup = $null
            try {
                $expected = @{}
                foreach ($n in $script:PayloadFiles) { $expected[$n] = $newFiles[$n].Sha256 }
                $backup = New-Backup -WorkRoot $work -VaultPath $vault -PluginDir $plugin -State $state -Commit $ExpectedCommit -RunId $RunId -Repository $Repository -NewFiles $newFiles
                Write-Info "backup: $backup"
                try {
                    Install-Files -SourceDir $extract -PluginDir $plugin -Expected $expected
                    if (-not (Test-InstalledBundle -PluginDir $plugin -Expect $newFiles)) { throw '適用後の3ファイル検証（hash/size/manifest id）に失敗しました' }
                    if ((Get-UserDataSnapshot $plugin) -cne $dataBefore) { throw 'data.json が変化しました' }
                } catch {
                    $reason = Hide-Secrets $_.Exception.Message
                    Write-Info "適用に失敗したためrollbackします: $reason"
                    $meta = Read-JsonFile (Join-Path $backup 'backup.json') 'backup.json'
                    if (Restore-FromBackup -BackupDir $backup -PluginDir $plugin -BackupMeta $meta -WorkRoot $work) {
                        if ($null -eq (Get-BackupExpect $meta)) {
                            Stop-Updater "適用に失敗し、元の状態（3ファイルが揃っていない状態）へ復元しました。3ファイルの完全な検証は行っておらず、プラグインは無効のままです: $reason" 1
                        }
                        if (Test-InstalledBundle -PluginDir $plugin -Expect (Get-BackupExpect $meta)) {
                            $session.Verified = $true
                            Stop-Updater "適用に失敗し、rollbackしました: $reason" 1
                        }
                        $reason = "$reason / rollback後の3ファイル検証に失敗"
                    }
                    Stop-Updater "適用に失敗し、rollbackも不完全です。手動で $backup\files から復元してください: $reason" 5
                }
                $session.Verified = $true
                Write-Info '3ファイルの更新と検証が完了しました（hash/size/manifest id確認済み）。'
                Write-Info "rollback: -Rollback -BackupDir `"$backup`""
            } finally {
                $enableOk = Exit-PluginQuiesce $session
            }
            if (-not $enableOk) { Stop-Updater '3ファイルの更新と検証は完了しましたが、プラグインの再有効化を確認できません。上記の手動対応を行ってください。' 3 }
            return [pscustomobject]@{ Mode = 'Applied'; BackupDir = $backup }
        } finally {
            Exit-VaultLock $lock
        }
    } finally {
        if ((Test-Path -LiteralPath $stage) -and (Test-PathUnder $stage $work)) {
            Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-VaultGanttRollback {
    [CmdletBinding()]
    param(
        [string]$BackupDir, [string]$VaultPath, [switch]$Apply, [switch]$AllowSyncedVault, [switch]$SyncPausedConfirmed,
        [switch]$UseObsidianCli, [string]$ObsidianCliVaultName, [string]$ObsidianCliPath = 'obsidian', [string]$WorkRoot
    )
    if (-not $VaultPath -or -not $BackupDir) { Stop-Updater 'VaultPath と BackupDir が必要です' 2 }
    $vault = Get-NormPath $VaultPath
    $plugin = Resolve-PluginDir $vault
    $work = Resolve-WorkRoot $WorkRoot $vault
    $bdir = Get-NormPath $BackupDir
    Assert-RestorePaths -BackupDir $bdir -WorkRoot $work -PluginDir $plugin

    $meta = Read-JsonFile (Join-Path $bdir 'backup.json') 'backup.json'
    if ((Get-Prop $meta 'schema') -ne 1) { Stop-Updater 'backup.json のschemaが未対応です' 2 }
    if (-not (Get-NormPath ([string](Get-Prop $meta 'vaultPath'))).Equals($vault, [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Updater 'backup は別のVaultのものです' 2 }
    if (-not (Get-NormPath ([string](Get-Prop $meta 'pluginDir'))).Equals((Get-NormPath $plugin), [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Updater 'backup のpluginDirが一致しません' 2 }
    $names = @($meta.files.PSObject.Properties.Name)
    if ($names.Count -ne 3) { Stop-Updater 'backup.json のfilesが3ファイルではありません' 2 }
    foreach ($n in $script:PayloadFiles) {
        $b = Get-Prop $meta.files $n
        if ($null -eq $b) { Stop-Updater "backup.json に $n がありません" 2 }
        if ($b.existed) {
            $f = Join-Path $bdir "files\$n"
            if (-not (Test-Path -LiteralPath $f -PathType Leaf) -or (Test-IsLink -Path $f -Strict)) { Stop-Updater "backupファイルが不正です: $n" 2 }
            if ((Get-Sha256 $f) -cne [string]$b.sha256) { Stop-Updater "backupファイルのhashが不一致です: $n" 2 }
        }
    }
    $state = Get-TargetState $plugin
    Write-Info "rollback対象: $plugin （backup: $bdir）"
    foreach ($n in $script:PayloadFiles) {
        $b = $meta.files.$n
        $cur = '(なし)'; if ($state[$n].Existed) { $cur = $state[$n].Sha256.Substring(0, 12) }
        $to = '(なし)'; if ($b.existed) { $to = ([string]$b.sha256).Substring(0, 12) }
        Write-Info "  $n : $cur -> $to"
    }
    if (-not $Apply) {
        Write-Info 'DRY-RUN: Vaultは変更していません。実行は -Apply を付けて再実行してください。'
        return [pscustomobject]@{ Mode = 'DryRun'; BackupDir = $bdir }
    }
    $lock = Enter-VaultLock $vault
    try {
        Assert-SyncGate -VaultPath $vault -AllowSyncedVault:$AllowSyncedVault -SyncPausedConfirmed:$SyncPausedConfirmed
        $session = Enter-PluginQuiesce -VaultPath $vault -UseObsidianCli:$UseObsidianCli -ObsidianCliVaultName $ObsidianCliVaultName -ObsidianCliPath $ObsidianCliPath
        $dataBefore = Get-UserDataSnapshot $plugin  # after disable (see apply)
        try {
            if (-not (Restore-FromBackup -BackupDir $bdir -PluginDir $plugin -BackupMeta $meta -WorkRoot $work)) {
                Stop-Updater 'rollbackが不完全です。ログを確認し、手動で復元してください。' 5
            }
            if ((Get-UserDataSnapshot $plugin) -cne $dataBefore) { Stop-Updater 'data.json が変化しました' 5 }
            $exp = Get-BackupExpect $meta
            if ($null -eq $exp) {
                Write-Info 'rollbackは、backup時点の元の状態（3ファイルが揃っていない状態）を復元しました。3ファイルの完全な検証は行っておらず、プラグインは無効のままです。'
            } else {
                if (-not (Test-InstalledBundle -PluginDir $plugin -Expect $exp)) {
                    Stop-Updater 'rollback後の3ファイル検証に失敗しました。手動で復元してください。' 5
                }
                $session.Verified = $true
                Write-Info 'rollbackが完了しました（3ファイルのhash/size/manifest idを確認済み）。'
            }
        } finally {
            $enableOk = Exit-PluginQuiesce $session
        }
        if (-not $enableOk) { Stop-Updater 'rollback（3ファイルの復元と検証）は完了しましたが、プラグインの再有効化を確認できません。上記の手動対応を行ってください。' 3 }
        return [pscustomobject]@{ Mode = 'RolledBack'; BackupDir = $bdir }
    } finally {
        Exit-VaultLock $lock
    }
}
