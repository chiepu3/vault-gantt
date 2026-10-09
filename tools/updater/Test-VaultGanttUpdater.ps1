<#
  Independent tests for the artifact updater. No Pester / no network / no real gh:
  gh access is replaced by in-process fakes. Only temp directories are touched.
  usage: powershell -NoProfile -File Test-VaultGanttUpdater.ps1   (exit 0 = all passed)
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
. (Join-Path $PSScriptRoot 'VaultGanttUpdater.Lib.ps1')

$Commit = ('a' * 40)
$OtherCommit = ('b' * 40)
$RunId = '4242'
$Repo = 'owner/vault-gantt-public'
$Branch = 'main'
$PsExe = (Get-Process -Id $PID).Path
$Root = Join-Path ([System.IO.Path]::GetTempPath()) "vg-updater-test-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $Root | Out-Null
$script:Pass = 0
$script:Fail = 0

# ---- fakes (override lib functions; resolved dynamically) ----
$script:Calls = New-Object System.Collections.ArrayList
$script:FakeRun = $null
$script:FakeArtifacts = $null
$script:FakeZip = $null
function Assert-GhReady { param([string]$GhPath = 'gh') [void]$script:Calls.Add('auth') }
function Get-GhJson {
    param([string]$Endpoint, [string]$GhPath = 'gh')
    [void]$script:Calls.Add($Endpoint)
    if ($Endpoint -match '/artifacts\?') { return $script:FakeArtifacts }
    return $script:FakeRun
}
function Save-GhArtifactZip {
    param([string]$Repository, [string]$ArtifactId, [string]$OutFile, [string]$GhPath = 'gh')
    [void]$script:Calls.Add("zip:$ArtifactId")
    Copy-Item -LiteralPath $script:FakeZip -Destination $OutFile
}

# fake Obsidian CLI: records enable/disable and mirrors them into community-plugins.json
$script:FakeCli = $false
$script:FakeVault = $null
$script:CliActions = New-Object System.Collections.ArrayList
$script:CorruptBackupMain = $false
$script:FakeDisableWritesData = $false
$script:FakeEnableNoop = $false
$script:OrigResolveCli = ${function:Resolve-ObsidianCli}
$script:OrigNewBackup = ${function:New-Backup}
$script:OrigSetCli = ${function:Set-PluginViaCli}
function Resolve-ObsidianCli {
    param([string]$CliPath, [string]$VaultName, [string]$VaultPath)
    if ($script:FakeCli) { return 'fake-cli' }
    return (& $script:OrigResolveCli -CliPath $CliPath -VaultName $VaultName -VaultPath $VaultPath)
}
function Set-PluginViaCli {
    param([string]$Cli, [string]$VaultName, [string]$Action)
    [void]$script:CliActions.Add($Action)
    if ($Action -eq 'enable' -and $script:FakeEnableNoop) { return $true }
    if ($Action -eq 'disable' -and $script:FakeDisableWritesData) {
        [System.IO.File]::WriteAllBytes((Join-Path $script:FakeVault '.obsidian\plugins\vault-gantt\data.json'), (New-Object System.Text.UTF8Encoding($false)).GetBytes('{"user":"written-on-unload"}'))
    }
    $list = '[]'; if ($Action -eq 'enable') { $list = '["vault-gantt"]' }
    [System.IO.File]::WriteAllBytes((Join-Path $script:FakeVault '.obsidian\community-plugins.json'), (New-Object System.Text.UTF8Encoding($false)).GetBytes($list))
    return $true
}
# wraps New-Backup so the old-version backup of main.js can be corrupted => restore must fail
$script:OrigEnterQuiesce = ${function:Enter-PluginQuiesce}
$script:BackupHook = $null
$script:QuiesceHook = $null
function Enter-PluginQuiesce {
    $sess = & $script:OrigEnterQuiesce @args
    if ($script:QuiesceHook) { & $script:QuiesceHook }
    return $sess
}
function New-Backup {
    $dir = & $script:OrigNewBackup @args
    if ($script:BackupHook) { & $script:BackupHook $dir }
    if ($script:CorruptBackupMain) { [System.IO.File]::WriteAllBytes((Join-Path $dir 'files\main.js'), (New-Object System.Text.UTF8Encoding($false)).GetBytes('corrupt')) }
    return $dir
}
function New-CliScenario {
    $s = New-Scenario
    [System.IO.File]::WriteAllBytes((Join-Path $s.Vault '.obsidian\community-plugins.json'), (Utf8 '["vault-gantt"]'))
    $script:FakeVault = $s.Vault; $script:FakeCli = $true; $script:CliActions.Clear()
    return $s
}
$CliExtra = @{ UseObsidianCli = $true; ObsidianCliVaultName = 'Vault'; ObsidianCliPath = 'fake' }

# ---- helpers ----
function Utf8 { param([string]$s) return ,((New-Object System.Text.UTF8Encoding($false)).GetBytes($s)) }
function Sha { param([byte[]]$b) $h = [System.Security.Cryptography.SHA256]::Create(); return ([BitConverter]::ToString($h.ComputeHash($b)) -replace '-', '').ToLowerInvariant() }

function New-Bundle {
    param([string]$ZipPath, [hashtable]$Opt = @{})
    $manifestId = 'vault-gantt'; if ($Opt['ManifestId']) { $manifestId = $Opt['ManifestId'] }
    $metaCommit = $Commit; if ($Opt['MetaCommit']) { $metaCommit = $Opt['MetaCommit'] }
    $metaRun = $RunId; if ($Opt['MetaRun']) { $metaRun = $Opt['MetaRun'] }
    $metaRef = $Branch; if ($Opt['MetaRef']) { $metaRef = $Opt['MetaRef'] }
    $metaAttempt = '1'; if ($Opt['MetaAttempt']) { $metaAttempt = $Opt['MetaAttempt'] }
    $bytes = [ordered]@{
        'main.js'       = (Utf8 "console.log('new bundle');")
        'manifest.json' = (Utf8 "{`"id`":`"$manifestId`",`"name`":`"Vault Gantt`",`"version`":`"9.9.9`"}")
        'styles.css'    = (Utf8 '.vg{color:red}')
    }
    $files = [ordered]@{}; $sums = @()
    foreach ($n in $bytes.Keys) {
        $h = Sha $bytes[$n]
        $files[$n] = [ordered]@{ sha256 = $h; size = $bytes[$n].Length }
        $sums += "$h  $n"
    }
    if ($Opt['TamperMain']) { $bytes['main.js'] = (Utf8 "console.log('XXX bundle');") }
    $mid = 'vault-gantt'; if ($Opt['MetaManifestId']) { $mid = $Opt['MetaManifestId'] }
    $meta = [ordered]@{ schema = 1; commit = $metaCommit; runId = $metaRun; runAttempt = $metaAttempt; repository = $Repo; ref = $metaRef; manifestId = $mid; manifestVersion = '9.9.9'; files = $files }
    $entries = [ordered]@{}
    foreach ($n in $bytes.Keys) { $entries[$n] = $bytes[$n] }
    $entries['metadata.json'] = (Utf8 ($meta | ConvertTo-Json -Depth 5))
    $entries['SHA256SUMS'] = (Utf8 (($sums -join "`n") + "`n"))
    if ($Opt['Omit']) { $entries.Remove($Opt['Omit']) }
    if ($Opt['Extra']) { foreach ($k in $Opt['Extra'].Keys) { $entries[$k] = $Opt['Extra'][$k] } }
    $z = [System.IO.Compression.ZipFile]::Open($ZipPath, 'Create')
    try {
        foreach ($n in $entries.Keys) {
            $e = $z.CreateEntry($n)
            if ($Opt['SymlinkEntry'] -and $n -ceq $Opt['SymlinkEntry']) { $e.ExternalAttributes = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]2717908992), 0) }
            $s = $e.Open(); $s.Write($entries[$n], 0, $entries[$n].Length); $s.Dispose()
        }
    } finally { $z.Dispose() }
}

function New-Scenario {
    param([hashtable]$BundleOpt = @{}, [hashtable]$RunOverride = @{}, [switch]$NoArtifact)
    $dir = Join-Path $Root ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $vault = Join-Path $dir 'Vault'
    $plugin = Join-Path $vault '.obsidian\plugins\vault-gantt'
    New-Item -ItemType Directory -Path $plugin -Force | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $plugin 'main.js'), (Utf8 'old main'))
    [System.IO.File]::WriteAllBytes((Join-Path $plugin 'manifest.json'), (Utf8 '{"id":"vault-gantt","version":"0.0.1"}'))
    [System.IO.File]::WriteAllBytes((Join-Path $plugin 'styles.css'), (Utf8 '.old{}'))
    [System.IO.File]::WriteAllBytes((Join-Path $plugin 'data.json'), (Utf8 '{"user":"settings"}'))
    [System.IO.File]::WriteAllBytes((Join-Path $vault '.obsidian\community-plugins.json'), (Utf8 '[]'))
    $zip = Join-Path $dir 'bundle.zip'
    New-Bundle -ZipPath $zip -Opt $BundleOpt
    $run = [ordered]@{
        id = [int64]$RunId; run_attempt = 1; workflow_id = 9001; status = 'completed'; conclusion = 'success'; head_sha = $Commit; head_branch = $Branch; event = 'push'
        path = '.github/workflows/vault-gantt-updater.yml'
        repository = [pscustomobject]@{ full_name = $Repo }; head_repository = [pscustomobject]@{ full_name = $Repo }
    }
    foreach ($k in $RunOverride.Keys) { $run[$k] = $RunOverride[$k] }
    $script:FakeRun = [pscustomobject]$run
    $arts = @()
    if (-not $NoArtifact) {
        $arts = @([pscustomobject]@{ id = 777; name = "vault-gantt-updater-$Commit"; expired = $false; size_in_bytes = (Get-Item $zip).Length
            workflow_run = [pscustomobject]@{ id = [int64]$RunId; head_sha = $Commit } })
    }
    $script:FakeArtifacts = [pscustomobject]@{ artifacts = $arts }
    $script:FakeZip = $zip
    $script:Calls.Clear()
    return [pscustomobject]@{ Dir = $dir; Vault = $vault; Plugin = $plugin; Work = (Join-Path $dir 'work') }
}

function Invoke-Update {
    param($S, [switch]$Apply, [hashtable]$Extra = @{}, [string]$Expected = $Commit)
    $p = @{ RunId = $RunId; ExpectedCommit = $Expected; Repository = $Repo; ExpectedBranch = $Branch; VaultPath = $S.Vault; WorkRoot = $S.Work; Apply = $Apply }
    foreach ($k in $Extra.Keys) { $p[$k] = $Extra[$k] }
    return (Invoke-VaultGanttUpdate @p)
}

function Check {
    param([string]$Name, [scriptblock]$Body)
    try { & $Body; $script:Pass++; Write-Host "  ok   $Name" }
    catch { $script:Fail++; Write-Host "  FAIL $Name : $($_.Exception.Message)" }
}
function Assert-True { param($Cond, [string]$Msg) if (-not $Cond) { throw "assertion failed: $Msg" } }
function Expect-Refusal {
    param([scriptblock]$Body, [int]$Code, [string]$Pattern = '')
    $threw = $null
    try { & $Body | Out-Null } catch { $threw = $_.Exception }
    if (-not $threw) { throw 'expected refusal but it succeeded' }
    $actual = 1; if ($threw.Data.Contains('ExitCode')) { $actual = [int]$threw.Data['ExitCode'] }
    if ($actual -ne $Code) { throw "exit code $actual != $Code ($($threw.Message))" }
    if ($Pattern -and $threw.Message -notmatch $Pattern) { throw "message '$($threw.Message)' !~ /$Pattern/" }
}
function Snapshot { param($S) $h = @{}; foreach ($f in 'main.js', 'manifest.json', 'styles.css', 'data.json') { $h[$f] = Get-Sha256 (Join-Path $S.Plugin $f) }; return $h }
function Assert-Unchanged { param($S, $Before) $now = Snapshot $S; foreach ($k in $Before.Keys) { Assert-True ($now[$k] -ceq $Before[$k]) "$k changed" } }
function New-Junction { param([string]$Link, [string]$Target) New-Item -ItemType Directory -Path $Target -Force | Out-Null; cmd /c mklink /J "`"$Link`"" "`"$Target`"" | Out-Null; Assert-True (Test-Path $Link) 'junction creation' }

Write-Host 'Vault Gantt artifact updater tests'

Check 'dry-run: verifies but writes nothing to the vault' {
    $s = New-Scenario; $b = Snapshot $s
    $r = Invoke-Update $s
    Assert-True ($r.Mode -eq 'DryRun') 'mode'
    Assert-Unchanged $s $b
    Assert-True (-not (Get-ChildItem $s.Plugin -Force | Where-Object { $_.Name -like '.*vg-*' })) 'temp files left'
    Assert-True (-not (Get-ChildItem $s.Work -Directory | Where-Object { $_.Name -like 'backup-*' })) 'backup created in dry-run'
    Assert-True (-not (Get-ChildItem $s.Work -Directory | Where-Object { $_.Name -like 'stage-*' })) 'staging not cleaned'
}

Check 'apply: normal bundle replaces 3 files, keeps data.json, backup outside vault, rollback restores' {
    $s = New-Scenario; $b = Snapshot $s
    $r = Invoke-Update $s -Apply
    Assert-True ($r.Mode -eq 'Applied') 'mode'
    Assert-True ((Get-Content (Join-Path $s.Plugin 'main.js') -Raw) -eq "console.log('new bundle');") 'main.js content'
    Assert-True ((Get-Sha256 (Join-Path $s.Plugin 'data.json')) -ceq $b['data.json']) 'data.json changed'
    Assert-True (-not (Test-PathUnder $r.BackupDir $s.Vault)) 'backup inside vault'
    Assert-True (Test-Path (Join-Path $r.BackupDir 'backup.json')) 'backup.json'
    Assert-True (@(Get-ChildItem $s.Plugin -Force).Count -eq 4) 'unexpected files in plugin dir'
    $null = Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work -Apply
    Assert-Unchanged $s $b
}

Check 'rollback dry-run changes nothing; rejects foreign vault / outside WorkRoot / tampered backup' {
    $s = New-Scenario
    $r = Invoke-Update $s -Apply
    $after = Snapshot $s
    $null = Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work
    Assert-Unchanged $s $after
    $other = New-Scenario
    Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $other.Vault -WorkRoot $s.Work -Apply } 2 '別のVault'
    $outside = Join-Path $Root 'outside-backup'
    Copy-Item $r.BackupDir $outside -Recurse
    Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $outside -VaultPath $s.Vault -WorkRoot $s.Work -Apply } 2 'WorkRoot配下'
    Set-Content (Join-Path $r.BackupDir 'files\main.js') 'corrupt'
    Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work -Apply } 2 'hash'
}

Check 'manifest id mismatch (in manifest.json) is refused' {
    $s = New-Scenario -BundleOpt @{ ManifestId = 'other-plugin' }; $b = Snapshot $s
    Expect-Refusal { Invoke-Update $s -Apply } 2 'id'
    Assert-Unchanged $s $b
}
Check 'manifest id mismatch (in metadata) is refused' {
    $s = New-Scenario -BundleOpt @{ MetaManifestId = 'other-plugin' }
    Expect-Refusal { Invoke-Update $s -Apply } 2 'manifestId'
}
Check 'metadata commit mismatch is refused' {
    $s = New-Scenario -BundleOpt @{ MetaCommit = $OtherCommit }
    Expect-Refusal { Invoke-Update $s -Apply } 2 'commit'
}
Check 'metadata run ID mismatch is refused' {
    $s = New-Scenario -BundleOpt @{ MetaRun = '1' }
    Expect-Refusal { Invoke-Update $s -Apply } 2 'runId'
}
Check 'file hash mismatch is refused, vault untouched' {
    $s = New-Scenario -BundleOpt @{ TamperMain = $true }; $b = Snapshot $s
    Expect-Refusal { Invoke-Update $s -Apply } 2 'SHA256'
    Assert-Unchanged $s $b
}
Check 'ExpectedCommit differing from the run head SHA is refused' {
    $s = New-Scenario; $b = Snapshot $s
    Expect-Refusal { Invoke-Update $s -Apply -Expected $OtherCommit } 2 'head SHA'
    Assert-Unchanged $s $b
}

Check 'zip: .. traversal entry refused' {
    $s = New-Scenario -BundleOpt @{ Extra = @{ '../evil.txt' = (Utf8 'x') } }
    Expect-Refusal { Invoke-Update $s -Apply } 2 '\.\.'
    Assert-True (-not (Test-Path (Join-Path $s.Dir 'evil.txt'))) 'file escaped'
}
Check 'zip: absolute path / subdirectory / extra file refused' {
    foreach ($name in '/abs.txt', 'C:\abs.txt', 'sub/main.js', 'data.json') {
        $s = New-Scenario -BundleOpt @{ Extra = @{ $name = (Utf8 'x') } }
        Expect-Refusal { Invoke-Update $s -Apply } 2
    }
}
Check 'zip: symlink entry refused' {
    $s = New-Scenario -BundleOpt @{ SymlinkEntry = 'main.js' }
    Expect-Refusal { Invoke-Update $s -Apply } 2 'symlink'
}
Check 'zip: missing entry refused' {
    $s = New-Scenario -BundleOpt @{ Omit = 'styles.css' }
    Expect-Refusal { Invoke-Update $s -Apply } 2 'styles.css'
}

Check 'reparse: plugin dir that is a junction is refused' {
    $s = New-Scenario
    $real = Join-Path $s.Dir 'elsewhere'
    Move-Item $s.Plugin $real
    New-Junction -Link $s.Plugin -Target $real
    try { Expect-Refusal { Invoke-Update $s -Apply } 2 'リンク' } finally { cmd /c rmdir "`"$($s.Plugin)`"" | Out-Null }
}
Check 'containment: .obsidian/plugins junction pointing outside the vault is refused' {
    $s = New-Scenario
    $pl = Join-Path $s.Vault '.obsidian\plugins'
    $real = Join-Path $s.Dir 'real-plugins'
    Move-Item $pl $real
    New-Junction -Link $pl -Target $real
    try { Expect-Refusal { Invoke-Update $s -Apply } 2 'リンク' } finally { cmd /c rmdir "`"$pl`"" | Out-Null }
}
Check 'containment: WorkRoot inside the vault is refused' {
    $s = New-Scenario
    Expect-Refusal { Invoke-Update $s -Apply -Extra @{ WorkRoot = (Join-Path $s.Vault 'work') } } 2 'WorkRoot'
}
Check 'containment: WorkRoot under OneDrive is refused' {
    $s = New-Scenario
    Expect-Refusal { Invoke-Update $s -Apply -Extra @{ WorkRoot = (Join-Path $s.Dir 'OneDrive\work') } } 2 'OneDrive'
}
Check 'containment: junction in a WorkRoot parent that points into the vault is refused' {
    $s = New-Scenario
    $parent = Join-Path $s.Dir 'tmp-link'
    New-Junction -Link $parent -Target (Join-Path $s.Vault 'inside')
    try {
        Expect-Refusal { Invoke-Update $s -Apply -Extra @{ WorkRoot = (Join-Path $parent 'work') } } 2 'WorkRoot'
        Assert-True (-not (Test-Path (Join-Path $s.Vault 'inside\work'))) 'WorkRoot created inside vault via junction'
    } finally { cmd /c rmdir "`"$parent`"" | Out-Null }
}
Check 'containment: junction in a rollback BackupDir parent is refused' {
    $s = New-Scenario
    $r = Invoke-Update $s -Apply
    $link = Join-Path $s.Dir 'work-link'
    New-Junction -Link $link -Target $s.Work
    try {
        Expect-Refusal { Invoke-VaultGanttRollback -BackupDir (Join-Path $link (Split-Path $r.BackupDir -Leaf)) -VaultPath $s.Vault -WorkRoot $link -Apply } 2 'WorkRoot'
    } finally { cmd /c rmdir "`"$link`"" | Out-Null }
}
Check 'target file reparse classification: non-symlink reparse refused, cloud placeholder allowed' {
    $mk = { param($attr, $lt) [pscustomobject]@{ Attributes = $attr; LinkType = $lt } }
    Assert-True (Test-IsUnsafeTargetFile (& $mk 0x420 $null)) 'plain reparse point accepted'
    Assert-True (Test-IsUnsafeTargetFile (& $mk 0x420 'SymbolicLink')) 'symlink accepted'
    Assert-True (Test-IsUnsafeTargetFile (& $mk 0x20 'Junction')) 'junction accepted'
    Assert-True (-not (Test-IsUnsafeTargetFile (& $mk 0x20 $null))) 'regular file rejected'
    Assert-True (-not (Test-IsUnsafeTargetFile (& $mk (0x420 -bor 0x400000) $null))) 'cloud placeholder rejected'
}
Check 'containment: junction in a Vault parent directory is refused (update and rollback)' {
    $s = New-Scenario
    $r = Invoke-Update $s -Apply
    $link = Join-Path $s.Dir 'vault-parent-link'
    New-Junction -Link $link -Target $s.Dir
    $viaLink = [pscustomobject]@{ Vault = (Join-Path $link 'Vault'); Plugin = $s.Plugin; Work = $s.Work; Dir = $s.Dir }
    try {
        $b = Snapshot $s
        Expect-Refusal { Invoke-Update $viaLink -Apply } 2 'リンク'
        Expect-Refusal { Invoke-Update $viaLink } 2 'リンク'
        Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $viaLink.Vault -WorkRoot $s.Work -Apply } 2 'リンク'
        Assert-Unchanged $s $b
    } finally { cmd /c rmdir "`"$link`"" | Out-Null }
}
# Moves Path outside the tree it lives in and puts a junction to it in its place; returns the moved location.
function Swap-ForJunction { param([string]$Path) $real = Join-Path $Root "swap-$([guid]::NewGuid().ToString('N').Substring(0, 8))"; Move-Item -LiteralPath $Path -Destination $real; New-Junction -Link $Path -Target $real; return $real }
function Remove-Junction { param([string]$Path) if (Test-Path -LiteralPath $Path) { cmd /c rmdir "`"$Path`"" | Out-Null } }

Check 'rollback validation: files dir replaced by a junction / unexpected entries are refused' {
    $s = New-Scenario; $r = Invoke-Update $s -Apply; $b = Snapshot $s
    $fd = Join-Path $r.BackupDir 'files'
    $moved = Swap-ForJunction $fd
    try { Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work -Apply } 2 'リンク' } finally { Remove-Junction $fd }
    Move-Item $moved $fd
    Set-Content (Join-Path $fd 'data.json') 'x'
    Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work -Apply } 2 '想定外'
    Remove-Item (Join-Path $fd 'data.json')
    Set-Content (Join-Path $r.BackupDir 'extra.txt') 'x'
    Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work -Apply } 2 '想定外'
    Assert-Unchanged $s $b
}
Check 'rollback time-of-use: files dir swapped for a junction after validation => exit 5, nothing enabled' {
    $s = New-Scenario; $r = Invoke-Update $s -Apply
    [System.IO.File]::WriteAllBytes((Join-Path $s.Vault '.obsidian\community-plugins.json'), (Utf8 '["vault-gantt"]'))
    $script:FakeVault = $s.Vault; $script:FakeCli = $true; $script:CliActions.Clear()
    $fd = Join-Path $r.BackupDir 'files'; $script:HookPath = $fd
    $script:QuiesceHook = { $null = Swap-ForJunction $script:HookPath }
    $b = Snapshot $s
    try { Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work -Apply @CliExtra } 5 }
    finally { $script:QuiesceHook = $null; $script:FakeCli = $false; Remove-Junction $fd }
    Assert-Unchanged $s $b
    Assert-True (($script:CliActions -join ',') -eq 'disable') "actions: $($script:CliActions -join ',')"
}
Check 'rollback time-of-use: plugin dir swapped for a junction after validation => exit 5, nothing enabled' {
    $s = New-Scenario; $r = Invoke-Update $s -Apply
    [System.IO.File]::WriteAllBytes((Join-Path $s.Vault '.obsidian\community-plugins.json'), (Utf8 '["vault-gantt"]'))
    $script:FakeVault = $s.Vault; $script:FakeCli = $true; $script:CliActions.Clear()
    $script:HookPath = $s.Plugin
    $script:QuiesceHook = { $script:MovedPlugin = Swap-ForJunction $script:HookPath }
    try { Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work -Apply @CliExtra } 5 }
    finally { $script:QuiesceHook = $null; $script:FakeCli = $false; Remove-Junction $s.Plugin }
    Assert-True (($script:CliActions -join ',') -eq 'disable') "actions: $($script:CliActions -join ',')"
    Assert-True ((Get-Content (Join-Path $script:MovedPlugin 'main.js') -Raw) -eq "console.log('new bundle');") 'restore wrote through the junction'
}
Check 'apply failure: backup tree tampered (junction) before auto-rollback => exit 5, not re-enabled' {
    $s = New-CliScenario
    $script:BackupHook = { param($dir) $null = Swap-ForJunction (Join-Path $dir 'files') }
    $lock = [System.IO.File]::Open((Join-Path $s.Plugin 'manifest.json'), 'Open', 'Read', 'Read')
    try { Expect-Refusal { Invoke-Update $s -Apply -Extra $CliExtra } 5 'rollback' }
    finally { $lock.Dispose(); $script:BackupHook = $null; $script:FakeCli = $false }
    Assert-True (($script:CliActions -join ',') -eq 'disable') "actions: $($script:CliActions -join ',')"
    Get-ChildItem $s.Work -Directory -Filter 'backup-*' | ForEach-Object { Remove-Junction (Join-Path $_.FullName 'files') }
}
Check 'workflow identity: exact path only (prefix collisions refused); explicit branch suffix and workflow_id handled' {
    foreach ($bad in '.github/workflows/vault-gantt-updater.yml.extra.yml', '.github/workflows/vault-gantt-updater.yml2', '.github/workflows/vault-gantt-updater.yml@refs/heads/other', '.github/workflows/vault-gantt-updater.yml@refs/heads/main.evil', 'x.github/workflows/vault-gantt-updater.yml') {
        $s = New-Scenario -RunOverride @{ path = $bad }; $b = Snapshot $s
        Expect-Refusal { Invoke-Update $s -Apply } 2 'workflow'
        Assert-True ($script:Calls.Count -eq 2) "continued after bad path: $($script:Calls -join ',')"
        Assert-Unchanged $s $b
    }
    $s = New-Scenario -RunOverride @{ path = '.github/workflows/vault-gantt-updater.yml@refs/heads/main' }
    Assert-True ((Invoke-Update $s).Mode -eq 'DryRun') 'explicit branch suffix should be accepted'
    $s = New-Scenario
    Expect-Refusal { Invoke-Update $s -Extra @{ ExpectedWorkflowId = '1234' } } 2 'workflow_id'
    Assert-True ((Invoke-Update $s -Extra @{ ExpectedWorkflowId = '9001' }).Mode -eq 'DryRun') 'matching workflow id should pass'
    Expect-Refusal { Invoke-Update $s -Extra @{ ExpectedWorkflowId = '90x1' } } 2 '数字'
}
Check 'metadata ref / runAttempt must match the verified run' {
    $s = New-Scenario -BundleOpt @{ MetaRef = 'feature/other' }
    Expect-Refusal { Invoke-Update $s -Apply } 2 'ref'
    $s = New-Scenario -BundleOpt @{ MetaAttempt = '2' }
    Expect-Refusal { Invoke-Update $s -Apply } 2 'runAttempt'
    $s = New-Scenario -RunOverride @{ run_attempt = 3 }
    Expect-Refusal { Invoke-Update $s -Apply } 2 'runAttempt'
}
Check 'CLI enable that returns success but is not reflected as enabled: exit 3, not reported as success' {
    $s = New-CliScenario
    $script:FakeEnableNoop = $true
    try { Expect-Refusal { Invoke-Update $s -Apply -Extra $CliExtra } 3 '再有効化を確認できません' } finally { $script:FakeEnableNoop = $false; $script:FakeCli = $false }
    Assert-True (($script:CliActions -join ',') -eq 'disable,enable') "actions: $($script:CliActions -join ',')"
    Assert-True ((Get-Content (Join-Path $s.Plugin 'main.js') -Raw) -eq "console.log('new bundle');") 'files should be updated'
}
Check 'rollback to an incomplete original: truthful message, plugin stays disabled' {
    $s = New-Scenario
    Remove-Item (Join-Path $s.Plugin 'styles.css')
    $r = Invoke-Update $s -Apply
    [System.IO.File]::WriteAllBytes((Join-Path $s.Vault '.obsidian\community-plugins.json'), (Utf8 '["vault-gantt"]'))
    $script:FakeVault = $s.Vault; $script:FakeCli = $true; $script:CliActions.Clear()
    try { $out = (& { $null = Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work -Apply @CliExtra } 6>&1 | Out-String) } finally { $script:FakeCli = $false }
    Assert-True (-not (Test-Path (Join-Path $s.Plugin 'styles.css'))) 'original (missing styles.css) not restored'
    Assert-True ($out -match '検証は行っておらず') "message not truthful: $out"
    Assert-True ($out -notmatch '確認済み') "claimed verification: $out"
    Assert-True (($script:CliActions -join ',') -eq 'disable') "actions: $($script:CliActions -join ',')"
    Assert-True ((Get-EnabledPluginIds $s.Vault) -notcontains 'vault-gantt') 'plugin re-enabled'
}
Check 'data.json baseline is taken after plugin disable (settings write on unload is not a mutation)' {
    $s = New-CliScenario
    $script:FakeDisableWritesData = $true
    try { $r = Invoke-Update $s -Apply -Extra $CliExtra } finally { $script:FakeDisableWritesData = $false; $script:FakeCli = $false }
    Assert-True ($r.Mode -eq 'Applied') 'apply should succeed'
    Assert-True ((Get-Content (Join-Path $s.Plugin 'data.json') -Raw) -eq '{"user":"written-on-unload"}') 'data.json not preserved as written on unload'
}

Check 'vault lock: second process/transaction cannot interleave while the first owns the Vault' {
    $s = New-Scenario
    $state = Join-Path $s.Dir 'child-state.xml'
    @{ Run = $script:FakeRun; Arts = $script:FakeArtifacts; Zip = $script:FakeZip } | Export-Clixml -Path $state -Depth 8
    $signal = Join-Path $s.Dir 'paused.flag'; $release = Join-Path $s.Dir 'release.flag'
    $childScript = Join-Path $s.Dir 'child.ps1'
    $code = @'
param($Lib, $State, $Vault, $Work, $Signal, $Release)
$ErrorActionPreference = 'Stop'
. $Lib
$sc = Import-Clixml $State
function Assert-GhReady { param([string]$GhPath = 'gh') }
function Get-GhJson { param([string]$Endpoint, [string]$GhPath = 'gh') if ($Endpoint -match '/artifacts\?') { return $sc.Arts }; return $sc.Run }
function Save-GhArtifactZip { param([string]$Repository, [string]$ArtifactId, [string]$OutFile, [string]$GhPath = 'gh') Copy-Item -LiteralPath $sc.Zip -Destination $OutFile }
$orig = ${function:Install-Files}
function Install-Files { Set-Content -LiteralPath $Signal -Value 'paused'; $t = 0; while (-not (Test-Path -LiteralPath $Release) -and $t -lt 120) { Start-Sleep -Milliseconds 200; $t++ }; & $orig @args }
$null = Invoke-VaultGanttUpdate -RunId '__RUN__' -ExpectedCommit '__COMMIT__' -Repository '__REPO__' -ExpectedBranch '__BRANCH__' -VaultPath $Vault -WorkRoot $Work -Apply
exit 0
'@
    $code = $code.Replace('__RUN__', $RunId).Replace('__COMMIT__', $Commit).Replace('__REPO__', $Repo).Replace('__BRANCH__', $Branch)
    [System.IO.File]::WriteAllText($childScript, $code, (New-Object System.Text.UTF8Encoding($true)))
    $lib = Join-Path $PSScriptRoot 'VaultGanttUpdater.Lib.ps1'
    $argList = @('-NoProfile', '-NonInteractive', '-File', "`"$childScript`"", "`"$lib`"", "`"$state`"", "`"$($s.Vault)`"", "`"$($s.Work)`"", "`"$signal`"", "`"$release`"")
    $child = Start-Process -FilePath $PsExe -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $s.Dir 'child.out') -RedirectStandardError (Join-Path $s.Dir 'child.err')
    $null = $child.Handle  # cache the handle so ExitCode is readable after exit
    try {
        $t = 0; while (-not (Test-Path $signal) -and $t -lt 300 -and -not $child.HasExited) { Start-Sleep -Milliseconds 200; $t++ }
        Assert-True (Test-Path $signal) "child never reached the write phase: $(Get-Content (Join-Path $s.Dir 'child.err') -Raw -ErrorAction SilentlyContinue)"
        $b = Snapshot $s
        $backups = @(Get-ChildItem $s.Work -Directory -Filter 'backup-*')
        Assert-True ($backups.Count -eq 1) 'child should own a backup'
        # second transactions (update + rollback) must be refused without touching anything or enabling the plugin
        $script:FakeVault = $s.Vault; $script:FakeCli = $true; $script:CliActions.Clear()
        [System.IO.File]::WriteAllBytes((Join-Path $s.Vault '.obsidian\community-plugins.json'), (Utf8 '["vault-gantt"]'))
        try {
            Expect-Refusal { Invoke-Update $s -Apply -Extra $CliExtra } 6 '実行中'
            Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $backups[0].FullName -VaultPath $s.Vault -WorkRoot $s.Work -Apply @CliExtra } 6 '実行中'
        } finally { $script:FakeCli = $false }
        Assert-True ($script:CliActions.Count -eq 0) "second transaction touched the plugin: $($script:CliActions -join ',')"
        Assert-Unchanged $s $b
        [System.IO.File]::WriteAllBytes((Join-Path $s.Vault '.obsidian\community-plugins.json'), (Utf8 '[]'))
        # a different Vault is not blocked
        $s2 = New-Scenario
        $r2 = Invoke-Update $s2 -Apply
        Assert-True ($r2.Mode -eq 'Applied') 'other vault should not contend'
    } finally {
        Set-Content -LiteralPath $release -Value 'go'
        if (-not $child.WaitForExit(60000)) { $child.Kill() }
    }
    Assert-True ($child.ExitCode -eq 0) "child exit $($child.ExitCode): $(Get-Content (Join-Path $s.Dir 'child.err') -Raw -ErrorAction SilentlyContinue)"
    Assert-True ((Get-Content (Join-Path $s.Plugin 'main.js') -Raw) -eq "console.log('new bundle');") 'first transaction did not complete'
    # lock released: a new transaction on the same vault is possible again
    $lk = Enter-VaultLock $s.Vault; Exit-VaultLock $lk
}
Check 'destination file that is a directory is refused' {
    $s = New-Scenario
    Remove-Item (Join-Path $s.Plugin 'styles.css'); New-Item -ItemType Directory (Join-Path $s.Plugin 'styles.css') | Out-Null
    Expect-Refusal { Invoke-Update $s -Apply } 2 '通常ファイル'
}

Check 'partial failure (locked manifest.json): rolled back, data.json kept, exit 1' {
    $s = New-Scenario; $b = Snapshot $s
    $lock = [System.IO.File]::Open((Join-Path $s.Plugin 'manifest.json'), 'Open', 'Read', 'Read')
    try { Expect-Refusal { Invoke-Update $s -Apply } 1 'rollback' } finally { $lock.Dispose() }
    Assert-Unchanged $s $b
    Assert-True (-not (Get-ChildItem $s.Plugin -Force | Where-Object { $_.Name -like '.*vg-*' })) 'temp files left'
}

Check 'old-run fallback refused: wrong head SHA stops after one lookup' {
    $s = New-Scenario -RunOverride @{ head_sha = $OtherCommit }; $b = Snapshot $s
    Expect-Refusal { Invoke-Update $s -Apply } 2 'head SHA'
    Assert-True ($script:Calls.Count -eq 2 -and $script:Calls[1] -eq "repos/$Repo/actions/runs/$RunId") "unexpected calls: $($script:Calls -join ',')"
    Assert-Unchanged $s $b
}
Check 'missing artifact does not fall back to anything else' {
    $s = New-Scenario -NoArtifact
    Expect-Refusal { Invoke-Update $s -Apply } 2 'artifact'
    Assert-True (@($script:Calls | Where-Object { $_ -like 'zip:*' }).Count -eq 0) 'downloaded something'
}
Check 'run state checks: not success / in progress / wrong branch / fork / PR event / wrong workflow' {
    foreach ($o in @{ conclusion = 'failure' }, @{ status = 'in_progress'; conclusion = $null }, @{ head_branch = 'feature/x' },
        @{ head_repository = [pscustomobject]@{ full_name = 'evil/fork' } }, @{ event = 'pull_request' }, @{ path = '.github/workflows/ci.yml' }) {
        $s = New-Scenario -RunOverride $o
        Expect-Refusal { Invoke-Update $s -Apply } 2
    }
}

Check 'sync gate: remotely-save vault denied by default, allowed only with both opt-ins' {
    $s = New-Scenario; $b = Snapshot $s
    New-Item -ItemType Directory (Join-Path $s.Vault '.obsidian\plugins\remotely-save') | Out-Null
    Expect-Refusal { Invoke-Update $s -Apply } 4 '同期'
    Expect-Refusal { Invoke-Update $s -Apply -Extra @{ AllowSyncedVault = $true } } 4
    Assert-Unchanged $s $b
    $r = Invoke-Update $s -Apply -Extra @{ AllowSyncedVault = $true; SyncPausedConfirmed = $true }
    Assert-True ($r.Mode -eq 'Applied') 'opt-in apply'
}
Check 'enabled plugin: apply safe-stops (code 3) without writing; CLI absent also safe-stops' {
    $s = New-Scenario; $b = Snapshot $s
    [System.IO.File]::WriteAllBytes((Join-Path $s.Vault '.obsidian\community-plugins.json'), (Utf8 '["vault-gantt"]'))
    Expect-Refusal { Invoke-Update $s -Apply } 3
    Expect-Refusal { Invoke-Update $s -Apply -Extra @{ UseObsidianCli = $true; ObsidianCliVaultName = 'Vault'; ObsidianCliPath = 'definitely-not-obsidian-cli' } } 3
    Assert-Unchanged $s $b
    Assert-True (@(Get-ChildItem $s.Work -Directory | Where-Object { $_.Name -like 'backup-*' }).Count -eq 0) 'backup created before safe stop'
}

Check 'CLI apply success: disables then re-enables once after full validation' {
    $s = New-CliScenario
    try { $r = Invoke-Update $s -Apply -Extra $CliExtra } finally { $script:FakeCli = $false }
    Assert-True ($r.Mode -eq 'Applied') 'mode'
    Assert-True (($script:CliActions -join ',') -eq 'disable,enable') "actions: $($script:CliActions -join ',')"
}
Check 'CLI apply failure with verified restore: old bundle validated, re-enabled (exit 1)' {
    $s = New-CliScenario; $b = Snapshot $s
    $lock = [System.IO.File]::Open((Join-Path $s.Plugin 'manifest.json'), 'Open', 'Read', 'Read')
    try { Expect-Refusal { Invoke-Update $s -Apply -Extra $CliExtra } 1 'rollback' } finally { $lock.Dispose(); $script:FakeCli = $false }
    Assert-Unchanged $s $b
    Assert-True (($script:CliActions -join ',') -eq 'disable,enable') "actions: $($script:CliActions -join ',')"
}
Check 'CLI apply failure + old-version restore failure: exit 5, plugin NOT re-enabled' {
    $s = New-CliScenario
    $lock = [System.IO.File]::Open((Join-Path $s.Plugin 'manifest.json'), 'Open', 'Read', 'Read')
    $script:CorruptBackupMain = $true
    try { Expect-Refusal { Invoke-Update $s -Apply -Extra $CliExtra } 5 'rollback' } finally { $lock.Dispose(); $script:FakeCli = $false; $script:CorruptBackupMain = $false }
    Assert-True (($script:CliActions -join ',') -eq 'disable') "enable was called: $($script:CliActions -join ',')"
    Assert-True ((Get-EnabledPluginIds $s.Vault) -notcontains 'vault-gantt') 'plugin left enabled'
}
Check 'CLI rollback command: restore failure (exit 5) does not re-enable; success re-enables' {
    $s = New-Scenario
    $r = Invoke-Update $s -Apply
    [System.IO.File]::WriteAllBytes((Join-Path $s.Vault '.obsidian\community-plugins.json'), (Utf8 '["vault-gantt"]'))
    $script:FakeVault = $s.Vault; $script:FakeCli = $true; $script:CliActions.Clear()
    $lock = [System.IO.File]::Open((Join-Path $s.Plugin 'main.js'), 'Open', 'Read', 'Read')
    try { Expect-Refusal { Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work -Apply @CliExtra } 5 } finally { $lock.Dispose() }
    Assert-True (($script:CliActions -join ',') -eq 'disable') "enable was called: $($script:CliActions -join ',')"
    [System.IO.File]::WriteAllBytes((Join-Path $s.Vault '.obsidian\community-plugins.json'), (Utf8 '["vault-gantt"]'))
    $script:CliActions.Clear()
    try { $null = Invoke-VaultGanttRollback -BackupDir $r.BackupDir -VaultPath $s.Vault -WorkRoot $s.Work -Apply @CliExtra } finally { $script:FakeCli = $false }
    Assert-True (($script:CliActions -join ',') -eq 'disable,enable') "actions: $($script:CliActions -join ',')"
}
Check 'originally disabled plugin is never enabled by the updater' {
    $s = New-Scenario
    $script:FakeVault = $s.Vault; $script:FakeCli = $true; $script:CliActions.Clear()
    try { $null = Invoke-Update $s -Apply -Extra $CliExtra } finally { $script:FakeCli = $false }
    Assert-True ($script:CliActions.Count -eq 0) "CLI used: $($script:CliActions -join ',')"
}

Check 'child process: real deadline kills only the owned hanging child (bystander survives)' {
    $pidFile = Join-Path $Root 'hang.pid'
    $by = [System.Diagnostics.Process]::Start((New-Object System.Diagnostics.ProcessStartInfo($PsExe, '-NoProfile -Command Start-Sleep -Seconds 120')))
    try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        Expect-Refusal { Invoke-NativeCapture -FilePath $PsExe -Arguments "-NoProfile -Command `"`$PID | Set-Content -LiteralPath '$pidFile'; Start-Sleep -Seconds 120`"" -TimeoutSec 3 } 1 'タイムアウト'
        $sw.Stop()
        Assert-True ($sw.Elapsed.TotalSeconds -lt 30) "deadline not enforced ($($sw.Elapsed.TotalSeconds)s)"
        $childPid = [int](Get-Content $pidFile)
        Start-Sleep -Milliseconds 500
        Assert-True ($null -eq (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) 'hanging child still alive'
        Assert-True (-not $by.HasExited) 'bystander process was killed'
    } finally { if (-not $by.HasExited) { $by.Kill() }; $by.Dispose() }
}
Check 'child process: 4MB stdout + 4MB stderr does not deadlock (memory and OutFile modes)' {
    $cmd = "-NoProfile -Command `"[Console]::Out.Write(('x' * 4MB)); [Console]::Error.Write(('y' * 4MB))`""
    $r = Invoke-NativeCapture -FilePath $PsExe -Arguments $cmd -TimeoutSec 60
    Assert-True ($r.ExitCode -eq 0 -and $r.Stdout.Length -eq 4MB -and $r.Stderr.Length -eq 4MB) "lengths $($r.Stdout.Length)/$($r.Stderr.Length) exit $($r.ExitCode)"
    $f = Join-Path $Root 'big.bin'
    $r2 = Invoke-NativeCapture -FilePath $PsExe -Arguments $cmd -OutFile $f -TimeoutSec 60
    Assert-True ((Get-Item $f).Length -eq 4MB -and $r2.Stderr.Length -eq 4MB) 'OutFile mode lengths'
}
Check 'child process: timeout removes partial OutFile; Set-PluginViaCli swallows launch failure (returns false)' {
    $f = Join-Path $Root 'partial.bin'
    Expect-Refusal { Invoke-NativeCapture -FilePath $PsExe -Arguments "-NoProfile -Command `"[Console]::Out.Write('abc'); Start-Sleep -Seconds 120`"" -OutFile $f -TimeoutSec 3 } 1
    Assert-True (-not (Test-Path $f)) 'partial file left'
    Assert-True ((& $script:OrigSetCli -Cli (Join-Path $Root 'no-such-cli.exe') -VaultName 'V' -Action 'enable') -eq $false) 'launch failure not swallowed'
}

Check 'entry script: mandatory params enforced; bad commit exits 2' {
    $ps = (Get-Process -Id $PID).Path
    $script = Join-Path $PSScriptRoot 'Update-VaultGantt.ps1'
    $ErrorActionPreference = 'Continue'
    & $ps -NoProfile -NonInteractive -File $script -VaultPath $Root 2>&1 | Out-Null
    Assert-True ($LASTEXITCODE -ne 0) 'missing RunId accepted'
    & $ps -NoProfile -NonInteractive -File $script -Repository $Repo -RunId 1 -ExpectedCommit abc -VaultPath $Root 2>&1 | Out-Null
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Assert-True ($code -eq 2) "exit code $code"
}

# cleanup (junctions already removed)
Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "passed=$($script:Pass) failed=$($script:Fail)"
if ($script:Fail -gt 0) { exit 1 }
exit 0
