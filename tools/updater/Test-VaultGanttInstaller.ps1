$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VaultGanttInstaller.Lib.ps1')

$script:CleanupFailurePatterns = @()
$script:CleanupWarnings = @()
function Write-Warning {
    [CmdletBinding()]
    param([string]$Message)
    $script:CleanupWarnings += $Message
    Microsoft.PowerShell.Utility\Write-Warning @PSBoundParameters
}
$script:NativeCleanup = ${function:Remove-InstallerTree}
function Remove-InstallerTree {
    param([string]$Path, [switch]$EmptyDirectoryOnly)
    foreach ($pattern in $script:CleanupFailurePatterns) {
        if ($pattern -and $Path.Contains($pattern)) { throw [System.IO.IOException]::new("simulated cleanup failure for $Path") }
    }
    & $script:NativeCleanup @PSBoundParameters
}

$script:Pass = 0
$script:Fail = 0
$script:Calls = New-Object System.Collections.ArrayList
$script:FailureOperation = $null
$script:SelectedSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$script:FetchedSha = $null
$script:MainContent = 'built main'
$script:StyleContent = 'built styles'
$script:ManifestContent = '{"id":"vault-gantt","version":"9.9.9"}'
$script:NativeImplementation = ${function:Invoke-NativeStrict}
$script:NativeRestore = ${function:Restore-InstallerFile}
$script:FailureRestoreName = $null
$script:SilentRestoreName = $null
$script:SilentRestoreMode = $null
$script:FailureMoveName = $null
$script:FailureMoveMode = $null
$script:NativeMove = ${function:Move-InstallerFile}
$script:LockManifestPath = $null
$script:ManifestLock = $null
$script:MenuChoice = '2'

function Read-Host { param([string]$Prompt); return $script:MenuChoice }
function Get-InstallerToolPaths { return @{ Git = 'git'; Node = 'node'; Npm = 'npm' } }
function Invoke-NativeStrict {
    param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [string]$Operation, [switch]$CaptureOutput)
    $call = [pscustomobject]@{ File = $FilePath; Args = @($Arguments); WorkingDirectory = $WorkingDirectory; Operation = $Operation }
    [void]$script:Calls.Add($call)
    if ($Operation -eq $script:FailureOperation) { throw "simulated $Operation failure" }

    if ($FilePath -eq 'git' -and ($Arguments -join ' ') -eq 'ls-remote --heads https://github.com/chiepu3/vault-gantt.git') {
        return @(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`trefs/heads/main",
            "$($script:SelectedSha)`trefs/heads/release/windows"
        )
    }
    if ($Operation -eq 'git fetch') { $script:FetchedSha = $Arguments[-1] }
    if ($FilePath -eq 'git' -and $Arguments -contains 'rev-parse') { return @($script:FetchedSha) }
    if ($FilePath -eq 'npm' -and ($Arguments -join ' ') -eq 'run build') {
        [System.IO.File]::WriteAllText((Join-Path $WorkingDirectory 'main.js'), $script:MainContent)
        [System.IO.File]::WriteAllText((Join-Path $WorkingDirectory 'styles.css'), $script:StyleContent)
        [System.IO.File]::WriteAllText((Join-Path $WorkingDirectory 'manifest.json'), $script:ManifestContent)
        if ($script:LockManifestPath) {
            $script:ManifestLock = [System.IO.File]::Open($script:LockManifestPath, 'Open', 'Read', 'Read')
        }
    }
    if ($CaptureOutput) { return @('ok') }
    return @()
}
function Restore-InstallerFile {
    param([string]$Name, [string]$BackupDirectory, [string]$TargetPath, [string]$RestorePath)
    if ($script:SilentRestoreName -ceq $Name) {
        if ($script:SilentRestoreMode -eq 'corrupt') { [System.IO.File]::WriteAllText($TargetPath, 'incorrect restore') }
        return
    }
    if ($script:FailureRestoreName -ceq $Name) { throw "simulated $Name restore failure" }
    if (-not $script:NativeRestore) { throw 'Restore-InstallerFile implementation is missing' }
    & $script:NativeRestore @PSBoundParameters
}

function Move-InstallerFile {
    param([string]$SourcePath, [string]$TargetPath, [bool]$Replace)
    if ([System.IO.Path]::GetFileName($SourcePath) -ceq $script:FailureMoveName) {
        if ($script:FailureMoveMode -eq 'missing') { [System.IO.File]::Delete($TargetPath) }
        elseif ($script:FailureMoveMode -eq 'changed') { [System.IO.File]::WriteAllText($TargetPath, 'partial replacement') }
        elseif ($script:FailureMoveMode -eq 'moved') { & $script:NativeMove @PSBoundParameters }
        throw [System.IO.IOException]::new('simulated Replace failure after changing destination (1176)')
    }
    & $script:NativeMove @PSBoundParameters
}

function New-TestSource {
    param([string]$Path)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $Path 'main.js'), $script:MainContent)
    [System.IO.File]::WriteAllText((Join-Path $Path 'styles.css'), $script:StyleContent)
    [System.IO.File]::WriteAllText((Join-Path $Path 'manifest.json'), $script:ManifestContent)
    return $Path
}

function Start-TestLockHolder {
    param([string]$Destination, [string]$Vault, [string]$Directory, [switch]$Updater)
    $lib = Join-Path $PSScriptRoot 'VaultGanttInstaller.Lib.ps1'
    $acquire = 'Enter-InstallerLock -DestinationPath $target'
    if ($Updater) { $lib = Join-Path $PSScriptRoot 'VaultGanttUpdater.Lib.ps1'; $acquire = 'Enter-VaultLock -VaultPath $target' }
    $target = if ($Updater) { $Vault } else { $Destination }
    $signal = Join-Path $Directory ([guid]::NewGuid().ToString('N') + '.ready')
    $release = $signal + '.release'
    # EncodedCommand preserves Japanese, spaces and literal paths without command-line quoting.
    $code = @"
`$ErrorActionPreference = 'Stop'
. '$($lib.Replace("'", "''"))'
`$target = '$($target.Replace("'", "''"))'
`$mutex = $acquire
try {
    [IO.File]::WriteAllText('$($signal.Replace("'", "''"))', 'ready')
    `$deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not [IO.File]::Exists('$($release.Replace("'", "''"))')) {
        if ([DateTime]::UtcNow -gt `$deadline) { throw 'release timed out' }
        Start-Sleep -Milliseconds 50
    }
} finally { `$mutex.ReleaseMutex(); `$mutex.Dispose() }
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
    $exe = (Get-Process -Id $PID).Path
    $child = Start-Process -FilePath $exe -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -PassThru -WindowStyle Hidden
    $null = $child.Handle
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $signal) -and -not $child.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if (-not (Test-Path -LiteralPath $signal)) {
        if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
        $child.Dispose()
        throw 'lock holder did not acquire the mutex'
    }
    return [pscustomobject]@{ Process = $child; Release = $release }
}
function Stop-TestLockHolder {
    param($Holder)
    try {
        [IO.File]::WriteAllText($Holder.Release, 'release')
        if (-not $Holder.Process.WaitForExit(5000)) { $Holder.Process.Kill(); $Holder.Process.WaitForExit(); throw 'lock holder did not exit' }
        Assert-True ($Holder.Process.ExitCode -eq 0) 'lock holder failed'
    } finally { $Holder.Process.Dispose() }
}

function Check {
    param([string]$Name, [scriptblock]$Body)
    try { & $Body; $script:Pass++; Write-Host "  ok   $Name" }
    catch { $script:Fail++; Write-Host "  FAIL $Name : $($_.Exception.Message)" }
}
function Assert-True { param($Condition, [string]$Message); if (-not $Condition) { throw "assertion failed: $Message" } }
function Get-Hashes {
    param([string]$Path)
    $result = @{}
    foreach ($name in 'main.js', 'manifest.json', 'styles.css', 'data.json', 'notes.md') {
        $file = Join-Path $Path $name
        if (Test-Path -LiteralPath $file -PathType Leaf) { $result[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
        else { $result[$name] = $null }
    }
    return $result
}
function New-TestDestination {
    param([string]$Root, [string]$Name)
    $path = Join-Path $Root $Name
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $path 'main.js'), 'old main')
    [System.IO.File]::WriteAllText((Join-Path $path 'manifest.json'), '{"id":"vault-gantt","version":"0.0.1"}')
    [System.IO.File]::WriteAllText((Join-Path $path 'styles.css'), 'old styles')
    [System.IO.File]::WriteAllText((Join-Path $path 'data.json'), '{"user":"keep"}')
    [System.IO.File]::WriteAllText((Join-Path $path 'notes.md'), 'leave notes alone')
    return $path
}
function Reset-Mock {
    $script:Calls.Clear()
    $script:FailureOperation = $null
    $script:FetchedSha = $null
    $script:CleanupWarnings = @()
}

$root = Join-Path ([System.IO.Path]::GetTempPath()) "Vault Gantt installer 日本語 test $([guid]::NewGuid().ToString('N'))"
New-InstallerOwnedDirectory -Path $root

Write-Host 'Vault Gantt Windows installer tests'

Check 'cloud tag allowlist accepts CLOUD and CLOUD_1 through CLOUD_F only' {
    foreach ($index in 0..15) {
        $tag = [uint32](2415919130 + $index * 4096)
        Assert-True (Test-VaultGanttCloudReparseTag $tag) ('cloud tag refused: {0:X8}' -f $tag)
    }
    foreach ($tag in 0, 2684354572, 2684354563, 2147483675, 2415984666, 2415919146) {
        Assert-True (-not (Test-VaultGanttCloudReparseTag ([uint32]$tag))) ('other tag accepted: {0:X8}' -f $tag)
    }
}

Check 'overridable tag reader allows cloud files and directories but rejects links and unknown tags' {
    function Get-VaultGanttReparseTag { param([string]$Path); return $script:TestReparseTag }
    foreach ($directory in $false, $true) {
        $item = [pscustomobject]@{ FullName = (Join-Path $root 'ドキュメント'); Attributes = [IO.FileAttributes]::ReparsePoint; PSIsContainer = $directory }
        foreach ($tag in 2415919130, 2415947802, 2415980570) {
            $script:TestReparseTag = [uint32]$tag
            Assert-InstallerSafeReparsePoint $item
            $caught = $null
            try { Assert-InstallerSafeReparsePoint $item -Strict } catch { $caught = $_ }
            Assert-True ($null -ne $caught) 'strict work/cleanup policy accepted cloud reparse point'
        }
        foreach ($tag in 2684354572, 2684354563, 2147483671, 0) {
            $script:TestReparseTag = [uint32]$tag
            # Cloud attribute bits must not bypass the tag allowlist.
            $item.Attributes = 0x400 -bor 0x1000 -bor 0x400000
            $caught = $null
            try { Assert-InstallerSafeReparsePoint $item } catch { $caught = $_ }
            Assert-True ($null -ne $caught -and $caught.Exception.Message -match 'reparse point') 'unsafe/unknown tag accepted'
        }
    }
    function Get-VaultGanttReparseTag { param([string]$Path); throw 'simulated tag query failure' }
    $caught = $null
    try { Assert-InstallerSafeReparsePoint $item } catch { $caught = $_ }
    Assert-True ($null -ne $caught -and $caught.Exception.Message -match 'tag query failure') 'tag query failure was ignored'
}

Check 'Japanese destination with cloud ancestors and existing cloud files installs and preserves backup' {
    $cloudRoot = Join-Path $root 'cloud-ドキュメント'
    $destination = New-TestDestination $cloudRoot 'Obsidian Vault\.obsidian\plugins\vault-gantt'
    $before = Get-Hashes $destination
    $work = Join-Path $root 'cloud-work'
    function Get-Item {
        [CmdletBinding()]
        param([string]$LiteralPath, [switch]$Force)
        $item = Microsoft.PowerShell.Management\Get-Item @PSBoundParameters
        if ($item.FullName.StartsWith($cloudRoot, [StringComparison]::OrdinalIgnoreCase)) {
            return [pscustomobject]@{ FullName = $item.FullName; Attributes = $item.Attributes -bor [IO.FileAttributes]::ReparsePoint; PSIsContainer = $item.PSIsContainer }
        }
        return $item
    }
    function Get-VaultGanttReparseTag { param([string]$Path); return [uint32]2415947802 }
    Reset-Mock
    Invoke-VaultGanttInstaller -Branch main -DestinationPath $destination -WorkRoot $work
    $backups = @(Get-ChildItem -LiteralPath $work -Directory -Filter 'backup-*')
    Assert-True ($backups.Count -eq 1) 'cloud installation did not retain backup'
    foreach ($name in $script:InstallerFiles) {
        Assert-True ((Get-FileHash -LiteralPath (Join-Path $backups[0].FullName $name)).Hash -ceq $before[$name]) "$name cloud backup mismatch"
    }
    Assert-True ((Get-Content -LiteralPath (Join-Path $destination 'main.js') -Raw) -ceq $script:MainContent) 'cloud installation did not deploy'
    Assert-True ($script:CleanupWarnings.Count -eq 0) 'cloud stage cleanup warned'
    Assert-True (@(Get-ChildItem -LiteralPath $destination -Force).Count -eq 5) 'cloud stage was not removed'
}

Check 'read-only cloud stage cleanup deletes only owned known files and leaves unexpected entries' {
    function Get-VaultGanttReparseTag { param([string]$Path); return [uint32]2415976474 } # CLOUD_E
    function Get-Item {
        [CmdletBinding()]
        param([string]$LiteralPath, [switch]$Force)
        $item = Microsoft.PowerShell.Management\Get-Item @PSBoundParameters
        if ($item.FullName -ceq $stagePath) {
            return [pscustomobject]@{ FullName = $item.FullName; Attributes = $item.Attributes -bor [IO.FileAttributes]::ReparsePoint; PSIsContainer = $item.PSIsContainer }
        }
        return $item
    }
    foreach ($unexpected in $false, $true) {
        Reset-Mock
        $stagePath = Join-Path $root ('.vault-gantt-installer-' + [guid]::NewGuid().ToString('N'))
        New-InstallerOwnedDirectory $stagePath -AllowCloudAncestors
        [IO.File]::WriteAllText((Join-Path $stagePath 'main.js'), 'stage file')
        if ($unexpected) { [IO.File]::WriteAllText((Join-Path $stagePath 'keep.txt'), 'leave untouched') }
        [IO.File]::SetAttributes($stagePath, [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReadOnly)
        Remove-InstallerPath -Path $stagePath -OwnedRoot $stagePath -CloudStage
        if ($unexpected) {
            Assert-True ($script:CleanupWarnings.Count -eq 1) 'unknown stage entry was accepted'
            Assert-True (Test-Path -LiteralPath (Join-Path $stagePath 'main.js')) 'stage cleanup partially deleted before refusal'
            Assert-True ((Get-Content -LiteralPath (Join-Path $stagePath 'keep.txt') -Raw) -ceq 'leave untouched') 'unknown entry deleted'
        } else {
            Assert-True ($script:CleanupWarnings.Count -eq 0 -and -not (Test-Path -LiteralPath $stagePath)) 'read-only cloud stage was not removed'
        }
    }
}

Check 'cloud stage cleanup preserves unknown files and directories added after enumeration' {
    function Get-ChildItem {
        [CmdletBinding()]
        param([string]$LiteralPath, [switch]$Force)
        $entries = @(Microsoft.PowerShell.Management\Get-ChildItem @PSBoundParameters)
        if ($LiteralPath -ceq $stagePath -and -not $script:ConcurrentStageEntryInjected) {
            $script:ConcurrentStageEntryInjected = $true
            # Simulate OneDrive adding an entry after the allowlist snapshot was taken.
            if ($entryKind -eq 'directory') { New-Item -ItemType Directory -Path $unknownPath | Out-Null }
            [IO.File]::WriteAllText($sentinelPath, 'preserve concurrent content')
        }
        return $entries
    }
    foreach ($entryKind in 'file', 'directory') {
        Reset-Mock
        $script:ConcurrentStageEntryInjected = $false
        $stagePath = Join-Path $root ('.vault-gantt-installer-' + [guid]::NewGuid().ToString('N'))
        New-InstallerOwnedDirectory $stagePath -AllowCloudAncestors
        $knownPath = Join-Path $stagePath 'main.js'
        [IO.File]::WriteAllText($knownPath, 'owned stage content')
        $unknownPath = Join-Path $stagePath 'concurrent-entry'
        $sentinelPath = if ($entryKind -eq 'directory') { Join-Path $unknownPath 'keep.txt' } else { $unknownPath }
        # Leave the directory as a normal directory: the old recursive native path
        # would follow it and delete the concurrent entry, even with -CloudStage.
        Remove-InstallerPath -Path $stagePath -OwnedRoot $stagePath -CloudStage
        Assert-True ($script:ConcurrentStageEntryInjected) 'concurrent entry was not injected'
        Assert-True (-not (Test-Path -LiteralPath $knownPath)) 'known stage file was not removed'
        Assert-True (Test-Path -LiteralPath $stagePath -PathType Container) 'nonempty stage was removed'
        Assert-True ((Get-Content -LiteralPath $sentinelPath -Raw) -ceq 'preserve concurrent content') 'concurrent entry was deleted or modified'
        Assert-True ($script:CleanupWarnings.Count -eq 1 -and $script:CleanupWarnings[0].Contains($stagePath)) 'nonempty stage did not report its residual path'
        Assert-True ($script:InstallerOwnedDirectories.ContainsKey($stagePath)) 'failed cleanup lost ownership tracking'
    }
}

Check 'cloud-only read failure stops before staging or replacement and gives OneDrive guidance' {
    $nativeRead = ${function:Read-InstallerExistingFile}
    foreach ($failedName in 'manifest.json', 'styles.css') {
        $destination = New-TestDestination $root ('cloud-read-failure-' + $failedName)
        $before = Get-Hashes $destination
        $work = Join-Path $root ('cloud-read-work-' + $failedName)
        $source = New-TestSource (Join-Path $root ('cloud-read-source-' + $failedName))
        New-Item -ItemType Directory -Path $work | Out-Null
        function Read-InstallerExistingFile {
            param([string]$Path)
            if ([IO.Path]::GetFileName($Path) -ceq $failedName) {
                # Exercise the real read-error handler with an inaccessible/missing path.
                return & $nativeRead -Path ($Path + '.unavailable')
            }
            return & $nativeRead @PSBoundParameters
        }
        $caught = $null
        try { Install-BuiltFiles -SourceDirectory $source -DestinationPath $destination -WorkDirectory $work } catch { $caught = $_ }
        Assert-True ($null -ne $caught -and $caught.Exception.Message -match 'このデバイス上に常に保持する') 'cloud read failure lacked guidance'
        $after = Get-Hashes $destination
        foreach ($name in $before.Keys) { Assert-True ($after[$name] -ceq $before[$name]) "$name changed after read failure" }
        Assert-True (@(Get-ChildItem -LiteralPath $destination -Force).Count -eq 5) 'read failure created stage files'
    }
}

Check 'native tag reader and ancestor checks reject a real junction on a Japanese path' {
    $outside = New-TestDestination $root 'junction-ドキュメント'
    $link = Join-Path $root 'junction-destination'
    New-Item -ItemType Junction -Path $link -Target $outside | Out-Null
    try {
        Assert-True ((Get-VaultGanttReparseTag $link) -eq [uint32]2684354563) 'junction tag mismatch'
        foreach ($path in $link, (Join-Path $link 'manifest.json')) {
            $caught = $null
            try { Assert-InstallerNoReparseChain $path } catch { $caught = $_ }
            Assert-True ($null -ne $caught) 'real junction ancestor accepted'
        }
    } finally { [IO.Directory]::Delete($link) }
}

Check 'native command nonzero exit is treated as failure' {
    $threw = $false
    try { & $script:NativeImplementation -FilePath $env:ComSpec -Arguments @('/c', 'exit', '23') -Operation 'test nonzero' }
    catch { $threw = $_.Exception.Message -match 'exit code 23' }
    Assert-True $threw 'nonzero native exit was ignored'
}

Check 'interactive selection resolves the numbered public branch' {
    $branches = @(
        [pscustomobject]@{ Branch = 'main'; Sha = ('a' * 40) },
        [pscustomobject]@{ Branch = 'release/windows'; Sha = ('b' * 40) }
    )
    $selected = Resolve-PublicBranch -Branches $branches
    Assert-True ($selected.Branch -ceq 'release/windows') 'number 2 did not select release/windows'
}

Check 'branch input must match an advertised branch exactly' {
    $destination = New-TestDestination $root 'branch-injection'
    $before = Get-Hashes $destination
    $work = Join-Path $root 'branch-work'
    Reset-Mock
    $threw = $false
    try { Invoke-VaultGanttInstaller -Branch '--upload-pack=evil' -DestinationPath $destination -WorkRoot $work } catch { $threw = $true }
    Assert-True $threw 'unlisted branch accepted'
    Assert-True (@($script:Calls | Where-Object { $_.Operation -eq 'git fetch' }).Count -eq 0) 'fetch ran for an unlisted branch'
    $after = Get-Hashes $destination
    foreach ($name in $before.Keys) { Assert-True ($before[$name] -ceq $after[$name]) "$name changed" }
}

Check 'fetch pins the selected public branch SHA and successful build replaces only 3 files' {
    $destination = New-TestDestination $root 'success'
    $before = Get-Hashes $destination
    $work = Join-Path $root 'success-work'
    Reset-Mock
    $output = @(Invoke-VaultGanttInstaller -Branch 'release/windows' -DestinationPath $destination -WorkRoot $work 6>&1)
    $hostText = (@($output | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } | ForEach-Object { [string]$_.MessageData }) -join "`n")
    $fetch = @($script:Calls | Where-Object { $_.Operation -eq 'git fetch' })
    Assert-True ($fetch.Count -eq 1 -and ($fetch[0].Args -contains $script:SelectedSha)) 'fetch did not use the advertised commit SHA'
    Assert-True (@($script:Calls | Where-Object { $_.Operation -eq 'npm ci' }).Count -eq 1) 'npm ci missing'
    Assert-True (@($script:Calls | Where-Object { $_.Operation -eq 'npm run build' }).Count -eq 1) 'build missing'
    $after = Get-Hashes $destination
    Assert-True ($after['main.js'] -cne $before['main.js']) 'main.js not updated'
    Assert-True ($after['manifest.json'] -cne $before['manifest.json']) 'manifest.json not updated'
    Assert-True ($after['styles.css'] -cne $before['styles.css']) 'styles.css not updated'
    Assert-True ($after['data.json'] -ceq $before['data.json']) 'data.json changed'
    Assert-True ($after['notes.md'] -ceq $before['notes.md']) 'notes changed'
    Assert-True (@(Get-ChildItem -LiteralPath $destination -Force).Count -eq 5) 'unexpected destination file'
    Assert-True ($hostText -match 'version 9\.9\.9') 'completion output omitted manifest.version'
    $backupDirectories = @(Get-ChildItem -LiteralPath $work -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue)
    Assert-True ($backupDirectories.Count -eq 1) 'successful install did not retain its backup'
    foreach ($name in $script:InstallerFiles) {
        Assert-True ((Get-FileHash -LiteralPath (Join-Path $backupDirectories[0].FullName $name) -Algorithm SHA256).Hash -ceq $before[$name]) "$name backup differs from original"
    }
    Assert-True ($hostText.Contains($backupDirectories[0].FullName)) 'backup location was not shown to the user'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $work 'repository'))) 'build checkout was not cleaned after success'
    Assert-True (@(Get-ChildItem -LiteralPath $work -Force).Count -eq 1) 'unexpected files were retained with backup'
}

Check 'successful deployment warns with residual paths and never cleans retained backup' {
    $destination = New-TestDestination $root 'cleanup-success'
    $before = Get-Hashes $destination
    $work = Join-Path $root 'cleanup-success-work'
    Reset-Mock
    $script:CleanupFailurePatterns = @('.vault-gantt-installer-', '\repository', 'backup-')
    try { $output = @(Invoke-VaultGanttInstaller -Branch 'release/windows' -DestinationPath $destination -WorkRoot $work 3>&1 6>&1) }
    finally { $script:CleanupFailurePatterns = @() }
    $warnings = @($output | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
    $warningText = (@($warnings | ForEach-Object { $_.Message }) -join "`n")
    $stagingDirectories = @(Get-ChildItem -LiteralPath $destination -Directory -Filter '.vault-gantt-installer-*')
    $repository = Join-Path $work 'repository'
    Assert-True ($warnings.Count -eq 2) 'cleanup failures did not emit one warning each'
    Assert-True ($stagingDirectories.Count -eq 1) 'staging cleanup failure did not leave its path'
    Assert-True (Test-Path -LiteralPath $repository -PathType Container) 'repository cleanup failure did not leave its path'
    Assert-True ($warningText.Contains("残留パス: $($stagingDirectories[0].FullName)")) 'warning omitted staging residual path'
    Assert-True ($warningText.Contains("残留パス: $repository")) 'warning omitted repository residual path'
    Assert-True ($warningText -notmatch 'backup-') 'retained backup was treated as cleanup residue'
    $after = Get-Hashes $destination
    Assert-True ($after['main.js'] -cne $before['main.js']) 'cleanup failure rolled back the successful deployment'
    $backupDirectories = @(Get-ChildItem -LiteralPath $work -Directory -Filter 'backup-*')
    Assert-True ($backupDirectories.Count -eq 1) 'retained backup was removed'
}

Check 'failed deployment preserves its original exception and warns on cleanup failure' {
    $destination = New-TestDestination $root 'cleanup-failure'
    $before = Get-Hashes $destination
    $work = Join-Path $root 'cleanup-failure-work'
    Reset-Mock
    $script:FailureOperation = 'npm ci'
    $script:CleanupFailurePatterns = @($work)
    $caught = $null
    try { Invoke-VaultGanttInstaller -Branch 'release/windows' -DestinationPath $destination -WorkRoot $work }
    catch { $caught = $_ }
    finally { $script:CleanupFailurePatterns = @(); $script:FailureOperation = $null }
    Assert-True ($null -ne $caught) 'deployment exception was lost'
    Assert-True ($caught.Exception.Message -ceq 'simulated npm ci failure') 'cleanup replaced the original deployment exception'
    Assert-True ($script:CleanupWarnings.Count -eq 1) 'cleanup failure warning was not added'
    Assert-True ($script:CleanupWarnings[0].Contains("残留パス: $work")) 'warning omitted the remaining WorkRoot path'
    Assert-True (Test-Path -LiteralPath $work -PathType Container) 'failed cleanup did not retain WorkRoot'
    $after = Get-Hashes $destination
    foreach ($name in $before.Keys) { Assert-True ($before[$name] -ceq $after[$name]) "$name changed after failed deployment" }
}

Check 'rollback failure retains backup and work root and reports both paths' {
    $destination = New-TestDestination $root 'rollback-failure'
    $work = Join-Path $root 'rollback-failure-work'
    Reset-Mock
    $script:FailureRestoreName = 'styles.css'
    $script:LockManifestPath = Join-Path $destination 'manifest.json'
    $threw = $false
    $message = ''
    try { Invoke-VaultGanttInstaller -Branch 'release/windows' -DestinationPath $destination -WorkRoot $work }
    catch { $threw = $true; $message = $_.Exception.Message }
    finally {
        if ($script:ManifestLock) { $script:ManifestLock.Dispose(); $script:ManifestLock = $null }
        $script:FailureRestoreName = $null
        $script:LockManifestPath = $null
    }
    Assert-True $threw 'deployment and rollback failure was ignored'
    Assert-True ($message -match 'rollbackも不完全') 'rollback failure was not reported'
    Assert-True ($message.Contains($work)) 'error omitted WorkRoot path'
    Assert-True (Test-Path -LiteralPath $work -PathType Container) 'WorkRoot was deleted after rollback failure'
    $backupDirectories = @(Get-ChildItem -LiteralPath $work -Directory -Filter 'backup-*')
    Assert-True ($backupDirectories.Count -eq 1) 'backup directory was deleted after rollback failure'
    Assert-True ($message.Contains($backupDirectories[0].FullName)) 'error omitted backup path'
    foreach ($name in $script:InstallerFiles) {
        Assert-True (Test-Path -LiteralPath (Join-Path $backupDirectories[0].FullName $name) -PathType Leaf) "$name backup missing after rollback failure"
    }
}

Check 'npm ci or build failure leaves every destination file unchanged' {
    foreach ($operation in 'npm ci', 'npm run build') {
        $destination = New-TestDestination $root ("failure-" + ($operation -replace '[^a-z]+', '-'))
        $before = Get-Hashes $destination
        $work = Join-Path $root ("work-" + [guid]::NewGuid().ToString('N'))
        Reset-Mock
        $script:FailureOperation = $operation
        $threw = $false
        try { Invoke-VaultGanttInstaller -Branch 'release/windows' -DestinationPath $destination -WorkRoot $work } catch { $threw = $true }
        Assert-True $threw "$operation failure ignored"
        $after = Get-Hashes $destination
        foreach ($name in $before.Keys) { Assert-True ($before[$name] -ceq $after[$name]) "$name changed after $operation failure" }
        Assert-True (-not (Test-Path -LiteralPath $work)) 'failed build work directory was retained'
    }
}

Check 'partial deployment failure restores old bundle and preserves user files' {
    $destination = New-TestDestination $root 'rollback'
    $before = Get-Hashes $destination
    $source = Join-Path $root 'built-files'
    New-Item -ItemType Directory -Path $source | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $source 'main.js'), $script:MainContent)
    [System.IO.File]::WriteAllText((Join-Path $source 'styles.css'), $script:StyleContent)
    [System.IO.File]::WriteAllText((Join-Path $source 'manifest.json'), $script:ManifestContent)
    $work = Join-Path $root 'rollback-work'
    New-Item -ItemType Directory -Path $work | Out-Null
    $lock = [System.IO.File]::Open((Join-Path $destination 'manifest.json'), 'Open', 'Read', 'Read')
    try {
        $threw = $false
        try { Install-BuiltFiles -SourceDirectory $source -DestinationPath $destination -WorkDirectory $work } catch { $threw = $true }
        Assert-True $threw 'locked manifest replacement succeeded'
    } finally { $lock.Dispose() }
    $after = Get-Hashes $destination
    foreach ($name in $before.Keys) { Assert-True ($before[$name] -ceq $after[$name]) "$name was not restored" }
    Assert-True (@(Get-ChildItem -LiteralPath $destination -Force).Count -eq 5) 'deployment temp files remain'
    Assert-True (@(Get-ChildItem -LiteralPath $work -Force).Count -eq 0) 'backup files were not cleaned'
}

Check 'installer scripts and shared path library are UTF-8 with BOM' {
    foreach ($name in 'Install-VaultGantt.ps1', 'VaultGanttInstaller.Lib.ps1', 'VaultGanttPathSafety.Lib.ps1', 'Test-VaultGanttInstaller.ps1') {
        $bytes = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $name))
        Assert-True ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) "$name lacks UTF-8 BOM"
    }
}

Check 'destination rejects other plugin IDs, malformed manifests and wrong first-install structure' {
    foreach ($manifest in '{"id":"another-plugin"}', '{"id":"Vault-Gantt"}', '{}', 'broken json') {
        $destination = New-TestDestination $root ('invalid-id-' + [guid]::NewGuid().ToString('N'))
        [IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), $manifest)
        $before = Get-Hashes $destination
        $work = Join-Path $root ('invalid-work-' + [guid]::NewGuid().ToString('N'))
        Reset-Mock
        $caught = $null
        try { Invoke-VaultGanttInstaller -Branch main -DestinationPath $destination -WorkRoot $work } catch { $caught = $_ }
        Assert-True ($null -ne $caught) 'invalid destination accepted'
        Assert-True (-not (Test-Path -LiteralPath $work)) 'work directory created for invalid destination'
        $after = Get-Hashes $destination
        foreach ($name in $before.Keys) { Assert-True ($before[$name] -ceq $after[$name]) "$name changed" }
    }
    foreach ($relative in 'wrong\.obsidian\plugins\other', 'wrong\plugins\vault-gantt', 'wrong\.obsidian\other\vault-gantt') {
        $path = Join-Path $root $relative
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        $caught = $null
        try { Resolve-InstallerDestination $path } catch { $caught = $_ }
        Assert-True ($null -ne $caught) "invalid structure accepted: $relative"
    }
}

Check 'first installation accepts standard plugin directory and removes WorkRoot on success' {
    $destination = Join-Path $root 'fresh\.obsidian\plugins\vault-gantt'
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $work = Join-Path $root 'fresh-work'
    Reset-Mock
    Invoke-VaultGanttInstaller -Branch main -DestinationPath $destination -WorkRoot $work
    Assert-True (-not (Test-Path -LiteralPath $work)) 'fresh-install work root retained'
    Assert-True (@(Get-ChildItem -LiteralPath $destination -Force).Count -eq 3) 'fresh installation did not install exactly 3 files'
}

Check 'Replace exception restores the failing file even when it vanished or changed' {
    foreach ($mode in 'missing', 'changed') {
        $destination = New-TestDestination $root ("replace-$mode")
        $before = Get-Hashes $destination
        $work = Join-Path $root ("replace-$mode-work")
        Reset-Mock
        $script:FailureMoveName = 'styles.css'; $script:FailureMoveMode = $mode
        $caught = $null
        try { Invoke-VaultGanttInstaller -Branch main -DestinationPath $destination -WorkRoot $work }
        catch { $caught = $_ }
        finally { $script:FailureMoveName = $null; $script:FailureMoveMode = $null }
        Assert-True ($null -ne $caught -and $caught.Exception.Message -match '既存ファイルを復元') 'verified rollback not reported'
        $after = Get-Hashes $destination
        foreach ($name in $before.Keys) { Assert-True ($before[$name] -ceq $after[$name]) "$name was not restored after $mode" }
        Assert-True (-not (Test-Path -LiteralPath $work)) 'verified rollback unnecessarily retained work root'
    }
}

Check 'silent incorrect or missing restoration retains backup and WorkRoot' {
    foreach ($mode in 'corrupt', 'missing') {
        $destination = New-TestDestination $root ("silent-$mode")
        $before = Get-Hashes $destination
        $work = Join-Path $root ("silent-$mode-work")
        Reset-Mock
        $script:FailureMoveName = 'styles.css'; $script:FailureMoveMode = 'missing'
        $script:SilentRestoreName = 'styles.css'; $script:SilentRestoreMode = $mode
        $caught = $null
        try { Invoke-VaultGanttInstaller -Branch main -DestinationPath $destination -WorkRoot $work }
        catch { $caught = $_ }
        finally {
            $script:FailureMoveName = $null; $script:FailureMoveMode = $null
            $script:SilentRestoreName = $null; $script:SilentRestoreMode = $null
        }
        Assert-True ($null -ne $caught -and $caught.Exception.Data['PreserveWorkRoot']) 'unverified rollback lost recovery directory'
        Assert-True ($caught.Exception.Message -match '手動復元' -and $caught.Exception.Message.Contains($work)) 'manual recovery guidance missing'
        $backup = @(Get-ChildItem -LiteralPath $work -Directory -Filter 'backup-*')
        Assert-True ($backup.Count -eq 1 -and $caught.Exception.Message.Contains($backup[0].FullName)) 'backup missing or not reported'
        foreach ($name in $script:InstallerFiles) {
            Assert-True ((Get-FileHash -LiteralPath (Join-Path $backup[0].FullName $name)).Hash -ceq $before[$name]) "$name recovery backup changed"
        }
        Assert-True ((Get-FileHash -LiteralPath (Join-Path $destination 'main.js')).Hash -ceq $before['main.js']) 'other file was not restored'
    }
}

Check 'failed initial Move removes attempted file and verifies original absence' {
    $destination = Join-Path $root 'fresh-rollback\.obsidian\plugins\vault-gantt'
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $work = Join-Path $root 'fresh-rollback-work'
    Reset-Mock
    $script:FailureMoveName = 'styles.css'; $script:FailureMoveMode = 'moved'
    $caught = $null
    try { Invoke-VaultGanttInstaller -Branch main -DestinationPath $destination -WorkRoot $work }
    catch { $caught = $_ }
    finally { $script:FailureMoveName = $null; $script:FailureMoveMode = $null }
    Assert-True ($null -ne $caught) 'partial initial deployment did not fail'
    Assert-True (@(Get-ChildItem -LiteralPath $destination -Force).Count -eq 0) 'original absence was not restored'
    Assert-True (-not (Test-Path -LiteralPath $work)) 'verified initial rollback retained work root'
}

Check 'rollback verifies absence even when removal silently leaves a new file' {
    $destination = Join-Path $root 'fresh-residue\.obsidian\plugins\vault-gantt'
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $work = Join-Path $root 'fresh-residue-work'
    Reset-Mock
    $script:FailureMoveName = 'styles.css'; $script:FailureMoveMode = 'moved'
    function Remove-Item {
        [CmdletBinding()]
        param([string]$LiteralPath, [switch]$Force)
        if ([IO.Path]::GetFileName($LiteralPath) -ceq 'styles.css') { return }
        Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
    }
    $caught = $null
    try { Invoke-VaultGanttInstaller -Branch main -DestinationPath $destination -WorkRoot $work }
    catch { $caught = $_ }
    finally { $script:FailureMoveName = $null; $script:FailureMoveMode = $null }
    Assert-True ($null -ne $caught -and $caught.Exception.Data['PreserveWorkRoot']) 'new file residue did not retain recovery directory'
    Assert-True ($caught.Exception.Message -match '元は存在しなかったファイル') 'absence verification failure not reported'
    Assert-True (Test-Path -LiteralPath $work) 'WorkRoot deleted despite residue'
}

Check 'normalized target lock contends with another installer and the artifact updater before backup' {
    $vault = Join-Path $root 'mutex-vault'
    $destination = Join-Path $vault '.obsidian\plugins\vault-gantt'
    New-TestDestination ([IO.Path]::GetDirectoryName($destination)) 'vault-gantt' | Out-Null
    $before = Get-Hashes $destination
    $source = New-TestSource (Join-Path $root 'mutex-source')
    $work = Join-Path $root 'mutex-work'
    New-Item -ItemType Directory -Path $work | Out-Null
    # Dot segments, case and trailing separators must hash to the same key.
    $alias = $destination.ToUpperInvariant() + '\.\'
    foreach ($updater in $false, $true) {
        $holder = Start-TestLockHolder -Destination $destination -Vault ($vault + '\.\') -Directory $root -Updater:$updater
        try {
            $caught = $null
            $timer = [Diagnostics.Stopwatch]::StartNew()
            try { Install-BuiltFiles -SourceDirectory $source -DestinationPath $alias -WorkDirectory $work } catch { $caught = $_ }
            $timer.Stop()
            Assert-True ($null -ne $caught -and $caught.Exception.Message -match '実行中') 'second transaction was not rejected'
            Assert-True ($timer.Elapsed.TotalSeconds -lt 3) 'second transaction waited for the lock'
            Assert-True (@(Get-ChildItem -LiteralPath $work -Force).Count -eq 0) 'backup was created before taking lock'
            $after = Get-Hashes $destination
            foreach ($name in $before.Keys) { Assert-True ($before[$name] -ceq $after[$name]) "$name changed while locked" }
        } finally { Stop-TestLockHolder $holder }
    }
    Install-BuiltFiles -SourceDirectory $source -DestinationPath $destination -WorkDirectory $work | Out-Null
    # A separate process can acquire the same mutex after normal completion.
    $holder = Start-TestLockHolder -Destination $destination -Directory $root
    Stop-TestLockHolder $holder
}

Check 'mutex remains held during rollback and is released after failure' {
    $destination = New-TestDestination $root 'mutex-rollback'
    $work = Join-Path $root 'mutex-rollback-work'
    Reset-Mock
    $script:FailureMoveName = 'styles.css'; $script:FailureMoveMode = 'missing'
    $restore = ${function:Restore-InstallerFile}
    $script:RollbackLockChecked = $false
    function Restore-InstallerFile {
        param([string]$Name, [string]$BackupDirectory, [string]$TargetPath, [string]$RestorePath)
        # Run the child as a contender: it must fail to acquire while rollback is active.
        $destinationPath = [IO.Path]::GetDirectoryName($TargetPath)
        $lib = (Join-Path $PSScriptRoot 'VaultGanttInstaller.Lib.ps1').Replace("'", "''")
        $target = $destinationPath.Replace("'", "''")
        $code = ". '$lib'; try { `$m = Enter-InstallerLock '$target'; `$m.ReleaseMutex(); `$m.Dispose(); exit 9 } catch { if (`$_.Exception.Message -match '実行中') { exit 0 }; exit 8 }"
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
        $child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -PassThru -WindowStyle Hidden
        $null = $child.Handle
        try {
            if (-not $child.WaitForExit(5000)) { $child.Kill(); $child.WaitForExit(); throw 'rollback lock check timed out' }
            Assert-True ($child.ExitCode -eq 0) 'mutex was not held through rollback'
            $script:RollbackLockChecked = $true
        } finally { $child.Dispose() }
        & $restore @PSBoundParameters
    }
    $caught = $null
    try { Invoke-VaultGanttInstaller -Branch main -DestinationPath $destination -WorkRoot $work }
    catch { $caught = $_ }
    finally { $script:FailureMoveName = $null; $script:FailureMoveMode = $null }
    Assert-True ($null -ne $caught -and $script:RollbackLockChecked) 'rollback was not exercised'
    Assert-True (-not (Test-Path -LiteralPath $work)) 'rollback did not verify restoration'
    $holder = Start-TestLockHolder -Destination $destination -Directory $root
    Stop-TestLockHolder $holder
}

Check 'cleanup removes deep node_modules and read-only files without following junctions' {
    Reset-Mock
    $work = Join-Path $root 'long-cleanup-work'
    New-InstallerOwnedDirectory $work
    $repository = Join-Path $work 'repository'
    New-Item -ItemType Directory -Path $repository | Out-Null
    $outside = Join-Path $root 'outside-cleanup'
    New-Item -ItemType Directory -Path $outside | Out-Null
    $sentinel = Join-Path $outside 'keep.json'
    [IO.File]::WriteAllText($sentinel, 'keep')
    # Initialize the native helper using a short, owned empty directory.
    $seed = Join-Path $work 'seed'; New-InstallerOwnedDirectory $seed
    Remove-InstallerPath -Path $seed -OwnedRoot $seed
    # Use extended-path Win32 creation, independent of the machine's long-path policy.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class InstallerLongPathFixture {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateDirectoryW(string path, IntPtr security);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SetFileAttributesW(string path, uint attributes);
    public static void Create(string root) {
        string path = root.StartsWith(@"\\") ? @"\\?\UNC\" + root.Substring(2) : @"\\?\" + root;
        for (int index = 1; index <= 18; index++) {
            path += @"\node_modules_" + index.ToString("00") + "_nested_package";
            if (!CreateDirectoryW(path, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        path += @"\deep.json";
        using (SafeFileHandle file = CreateFileW(path, 0x40000000, 0, IntPtr.Zero, 1, 0x80, IntPtr.Zero)) {
            if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            using (var stream = new System.IO.FileStream(file, System.IO.FileAccess.Write)) { stream.WriteByte(65); }
        }
        if (!SetFileAttributesW(path, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@ -ErrorAction Stop
    [InstallerLongPathFixture]::Create($repository)
    $deep = $repository
    foreach ($index in 1..18) { $deep += '\node_modules_' + $index.ToString('00') + '_nested_package' }
    $junction = Join-Path $repository 'external-link'
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    Assert-True ($deep.Length -gt 500 -and [VaultGanttInstaller.NativeCleanup]::Exists($deep + '\deep.json')) 'long-path fixture missing'
    Remove-InstallerPath -Path $repository -OwnedRoot $work
    Assert-True (-not (Test-Path -LiteralPath $repository)) 'deep repository remained'
    Assert-True ((Get-Content -LiteralPath $sentinel -Raw) -ceq 'keep') 'junction target was deleted'
    Assert-True ($script:CleanupWarnings.Count -eq 0) 'long-path cleanup warned'
    Remove-InstallerPath -Path $work -OwnedRoot $work
    Assert-True (-not (Test-Path -LiteralPath $work)) 'owned WorkRoot remained'
}

Check 'cleanup rejects unowned roots, sibling prefixes and reparse ancestors' {
    Reset-Mock
    $owned = Join-Path $root 'owned-cleanup'
    New-InstallerOwnedDirectory $owned
    $sibling = $owned + '-sibling'
    New-Item -ItemType Directory -Path $sibling | Out-Null
    $sentinel = Join-Path $sibling 'keep.txt'; [IO.File]::WriteAllText($sentinel, 'keep')
    Remove-InstallerPath -Path $sibling -OwnedRoot $owned
    Remove-InstallerPath -Path $sibling -OwnedRoot $sibling
    $link = Join-Path $owned 'link'
    New-Item -ItemType Junction -Path $link -Target $sibling | Out-Null
    Remove-InstallerPath -Path (Join-Path $link 'keep.txt') -OwnedRoot $owned
    Assert-True (Test-Path -LiteralPath $sentinel) 'cleanup escaped the owned directory'
    Assert-True ($script:CleanupWarnings.Count -eq 3) 'unsafe cleanup was not refused'
    Remove-InstallerPath -Path $owned -OwnedRoot $owned
    Assert-True (Test-Path -LiteralPath $sentinel) 'owned cleanup followed a link'
}

Remove-InstallerPath -Path $root -OwnedRoot $root
Write-Host "passed=$($script:Pass) failed=$($script:Fail)"
if ($script:Fail -gt 0) { exit 1 }
exit 0
