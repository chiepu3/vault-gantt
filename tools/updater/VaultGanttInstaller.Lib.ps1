Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'VaultGanttPathSafety.Lib.ps1')

$script:InstallerRepositoryUrl = 'https://github.com/chiepu3/vault-gantt.git'
$script:InstallerFiles = @('main.js', 'manifest.json', 'styles.css')
$script:InstallerPluginId = 'vault-gantt'
$script:InstallerOwnedDirectories = @{}

function Stop-Installer {
    param([string]$Message)
    throw [System.InvalidOperationException]::new($Message)
}

function Get-InstallerToolPaths {
    $paths = @{}
    foreach ($name in 'git', 'node') {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $command) { Stop-Installer "$name が見つかりません。インストールしてPATHを設定してください。" }
        $paths[$name.Substring(0, 1).ToUpperInvariant() + $name.Substring(1)] = $command.Source
    }
    $npm = Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npm) { $npm = Get-Command -Name 'npm' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if (-not $npm) { Stop-Installer 'npm が見つかりません。Node.jsをインストールしてPATHを設定してください。' }
    $paths['Npm'] = $npm.Source
    return $paths
}

function Invoke-NativeStrict {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$Operation,
        [switch]$CaptureOutput
    )
    $pushed = $false
    try {
        if ($WorkingDirectory) {
            Push-Location -LiteralPath $WorkingDirectory
            $pushed = $true
        }
        if ($CaptureOutput) { $output = @(& $FilePath @Arguments 2>&1) }
        else { & $FilePath @Arguments; $output = @() }
        $exitCode = $LASTEXITCODE
    } catch {
        throw "$Operation を起動できませんでした: $($_.Exception.Message)"
    } finally {
        if ($pushed) { Pop-Location }
    }
    if ($null -eq $exitCode -or $exitCode -ne 0) {
        $detail = ''
        if ($output.Count -gt 0) { $detail = ' ' + (($output | ForEach-Object { [string]$_ }) -join ' ') }
        Stop-Installer "$Operation に失敗しました (exit code $exitCode).$detail"
    }
    if ($CaptureOutput) { return ,@($output | ForEach-Object { [string]$_ }) }
}

function Assert-InstallerPreflight {
    param([hashtable]$ToolPaths)
    Invoke-NativeStrict -FilePath $ToolPaths.Git -Arguments @('--version') -Operation 'git --version' | Out-Null
    Invoke-NativeStrict -FilePath $ToolPaths.Node -Arguments @('--version') -Operation 'node --version' | Out-Null
    Invoke-NativeStrict -FilePath $ToolPaths.Npm -Arguments @('--version') -Operation 'npm --version' | Out-Null
}

function Get-PublicBranches {
    param([string]$GitPath)
    $lines = Invoke-NativeStrict -FilePath $GitPath -Arguments @('ls-remote', '--heads', $script:InstallerRepositoryUrl) -Operation 'git ls-remote' -CaptureOutput
    $branches = @()
    foreach ($line in @($lines)) {
        $parts = ([string]$line).Trim() -split '\s+', 2
        if ($parts.Count -ne 2 -or $parts[1] -notmatch '^refs/heads/.+$') { continue }
        if ($parts[0] -cnotmatch '^[0-9a-fA-F]{40}$') { continue }
        $branchName = $parts[1].Substring('refs/heads/'.Length)
        $branches += [pscustomobject]@{ Branch = $branchName; Sha = $parts[0].ToLowerInvariant() }
    }
    if ($branches.Count -eq 0) { Stop-Installer '公開ブランチを取得できませんでした。ネットワークを確認してください。' }
    return @($branches | Sort-Object -Property Branch)
}

function Resolve-PublicBranch {
    param([object[]]$Branches, [string]$Branch)
    if ($Branch) {
        if ($Branch -match '[\r\n]' -or $Branch -match '^\s|\s$') { Stop-Installer 'Branchの形式が不正です。' }
        $matches = @($Branches | Where-Object { $_.Branch -ceq $Branch })
        if ($matches.Count -ne 1) { Stop-Installer "指定されたbranchは公開一覧にありません: $Branch" }
        return $matches[0]
    }

    $choice = Read-Host '番号を選択'
    $index = 0
    if (-not [int]::TryParse($choice, [ref]$index) -or $index -lt 1 -or $index -gt $Branches.Count) {
        Stop-Installer '選択番号が不正です。installerを再実行してください。'
    }
    return $Branches[$index - 1]
}

function Get-InstallerNormalizedPath {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\', '/') }
    return $full
}

# Overridable separately from the native tag reader in unit tests.
function Assert-InstallerSafeReparsePoint {
    param($Item, [switch]$Strict)
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { return }
    if (-not $Strict) {
        $tag = Get-VaultGanttReparseTag -Path $Item.FullName
        if (Test-VaultGanttCloudReparseTag -Tag $tag) { return }
    }
    Stop-Installer "パスに許可されていないreparse pointがあります: $($Item.FullName)"
}

function Assert-InstallerNoReparseChain {
    param([string]$Path, [switch]$Strict)
    $current = Get-InstallerNormalizedPath $Path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            Assert-InstallerSafeReparsePoint -Item $item -Strict:$Strict
        }
        $current = [System.IO.Path]::GetDirectoryName($current)
    }
}

function Read-InstallerExistingFile {
    param([string]$Path)
    try { return ,([System.IO.File]::ReadAllBytes($Path)) }
    catch {
        Stop-Installer "既存ファイルを読み込めません: $Path。OneDriveでこのフォルダを『このデバイス上に常に保持する』にしてから再実行してください。$($_.Exception.Message)"
    }
}

function Resolve-InstallerDestination {
    param([string]$DestinationPath)
    if (-not $DestinationPath) { $DestinationPath = Read-Host '配置先フォルダー（Vault Ganttのpluginフォルダー）' }
    if (-not $DestinationPath -or [string]::IsNullOrWhiteSpace($DestinationPath)) { Stop-Installer '配置先フォルダーが必要です。' }
    try { $fullPath = Get-InstallerNormalizedPath $DestinationPath }
    catch { Stop-Installer "配置先パスが不正です: $DestinationPath" }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) { Stop-Installer "配置先フォルダーがありません: $fullPath" }
    Assert-InstallerNoReparseChain $fullPath
    $manifestPath = Join-Path $fullPath 'manifest.json'
    if (Test-Path -LiteralPath $manifestPath) {
        $item = Get-Item -LiteralPath $manifestPath -Force
        if ($item.PSIsContainer) {
            Stop-Installer '配置先のmanifest.jsonが通常ファイルではありません。'
        }
        Assert-InstallerSafeReparsePoint -Item $item
        $manifestBytes = Read-InstallerExistingFile -Path $manifestPath
        try { $manifest = [System.Text.Encoding]::UTF8.GetString($manifestBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json }
        catch { Stop-Installer '配置先のmanifest.jsonを解析できません。' }
        if (-not $manifest -or -not $manifest.PSObject.Properties['id'] -or $manifest.id -cne $script:InstallerPluginId) {
            Stop-Installer '配置先のmanifest.jsonのidがvault-ganttではありません。'
        }
    } else {
        $plugins = [System.IO.Path]::GetDirectoryName($fullPath)
        $config = [System.IO.Path]::GetDirectoryName($plugins)
        if ([System.IO.Path]::GetFileName($fullPath) -ine 'vault-gantt' -or
            [System.IO.Path]::GetFileName($plugins) -ine 'plugins' -or
            [System.IO.Path]::GetFileName($config) -ine '.obsidian') {
            Stop-Installer '初回の配置先は<Vault>\.obsidian\plugins\vault-ganttである必要があります。'
        }
    }
    return $fullPath
}

function Get-InstallerLockName {
    param([string]$DestinationPath)
    $target = Get-InstallerNormalizedPath $DestinationPath
    $plugins = [System.IO.Path]::GetDirectoryName($target)
    $config = [System.IO.Path]::GetDirectoryName($plugins)
    $prefix = 'Global\VaultGanttInstaller-'
    if ([System.IO.Path]::GetFileName($target) -ieq 'vault-gantt' -and
        [System.IO.Path]::GetFileName($plugins) -ieq 'plugins' -and
        [System.IO.Path]::GetFileName($config) -ieq '.obsidian') {
        # Same canonical Vault path, UTF-8, SHA256 and first 32 hex digits as Enter-VaultLock.
        $target = Get-InstallerNormalizedPath ([System.IO.Path]::GetDirectoryName($config))
        $prefix = 'Global\VaultGanttUpdater-'
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hex = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant()))).Replace('-', '') }
    finally { $sha.Dispose() }
    return $prefix + $hex.Substring(0, 32)
}

function Enter-InstallerLock {
    param([string]$DestinationPath)
    $mutex = New-Object System.Threading.Mutex($false, (Get-InstallerLockName $DestinationPath))
    try {
        $acquired = $false
        try { $acquired = $mutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] {
            $acquired = $true
            Write-Warning '前回の処理が異常終了した可能性があります。backupと配置先の状態を確認してください。' -WarningAction Continue
        }
        if (-not $acquired) { Stop-Installer '同じ配置先で別のinstall/update/rollbackが実行中です。完了後に再実行してください。' }
        return $mutex
    } catch { $mutex.Dispose(); throw }
}

function New-InstallerOwnedDirectory {
    param([string]$Path, [switch]$AllowCloudAncestors)
    $full = Get-InstallerNormalizedPath $Path
    Assert-InstallerNoReparseChain $full -Strict:(-not $AllowCloudAncestors)
    if (Test-Path -LiteralPath $full) { Stop-Installer "作業フォルダーが既に存在します: $full" }
    New-Item -ItemType Directory -Path $full -ErrorAction Stop | Out-Null
    $script:InstallerOwnedDirectories[$full] = $true
}

function Assert-BuiltFiles {
    param([string]$SourceDirectory)
    foreach ($name in $script:InstallerFiles) {
        $path = Join-Path $SourceDirectory $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Stop-Installer "ビルド成果物がありません: $name" }
        $file = Get-Item -LiteralPath $path -Force
        if ($file.Length -le 0 -or ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Stop-Installer "ビルド成果物が空、または通常ファイルではありません: $name"
        }
    }
    try { $manifest = Get-Content -LiteralPath (Join-Path $SourceDirectory 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { Stop-Installer 'manifest.jsonを解析できません。' }
    if ($manifest.id -cne $script:InstallerPluginId) { Stop-Installer "manifest.jsonのidが$($script:InstallerPluginId)ではありません。" }
    return [string]$manifest.version
}

function Move-InstallerFile {
    param([string]$SourcePath, [string]$TargetPath, [bool]$Replace)
    if ($Replace) { [System.IO.File]::Replace($SourcePath, $TargetPath, [NullString]::Value) }
    else { [System.IO.File]::Move($SourcePath, $TargetPath) }
}

function Restore-InstallerFile {
    param([string]$Name, [string]$BackupDirectory, [string]$TargetPath, [string]$RestorePath)
    Copy-Item -LiteralPath (Join-Path $BackupDirectory $Name) -Destination $RestorePath -ErrorAction Stop
    Move-InstallerFile -SourcePath $RestorePath -TargetPath $TargetPath -Replace (Test-Path -LiteralPath $TargetPath)
}

function Remove-InstallerTree {
    param([string]$Path)
    # PS 5.1 Remove-Item cannot reliably enumerate deep node_modules paths.
    # Unicode Win32 APIs with extended paths also work without LongPathsEnabled.
    if (-not ('VaultGanttInstaller.NativeCleanup' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace VaultGanttInstaller {
    public static class NativeCleanup {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct FindData {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, AccessTime, WriteTime;
            public uint SizeHigh, SizeLow, Reserved0, Reserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string AlternateName;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr FindFirstFileW(string path, out FindData data);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool FindNextFileW(IntPtr handle, out FindData data);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool FindClose(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFileAttributesW(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetFileAttributesW(string path, uint attributes);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool DeleteFileW(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool RemoveDirectoryW(string path);
        static void Fail(string path) { throw new Win32Exception(Marshal.GetLastWin32Error(), path); }
        public static string Extended(string path) {
            if (path.StartsWith(@"\\?\")) return path;
            return path.StartsWith(@"\\") ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
        }
        public static bool Exists(string path) {
            uint attr = GetFileAttributesW(Extended(path));
            if (attr != UInt32.MaxValue) return true;
            int error = Marshal.GetLastWin32Error();
            if (error == 2 || error == 3) return false;
            throw new Win32Exception(error, path);
        }
        public static void DeleteTree(string path) { DeleteEntry(Extended(path)); }
        static void DeleteEntry(string path) {
            uint attr = GetFileAttributesW(path);
            if (attr == UInt32.MaxValue) { Fail(path); }
            bool directory = (attr & 0x10) != 0;
            bool reparse = (attr & 0x400) != 0;
            // Remove links themselves. Never enumerate or change attributes through a link.
            if (directory && !reparse) {
                FindData data;
                IntPtr handle = FindFirstFileW(path + @"\*", out data);
                if (handle == new IntPtr(-1)) {
                    if (Marshal.GetLastWin32Error() != 2) Fail(path);
                } else {
                    try {
                        do {
                            if (data.Name != "." && data.Name != "..") DeleteEntry(path + @"\" + data.Name);
                        } while (FindNextFileW(handle, out data));
                        if (Marshal.GetLastWin32Error() != 18) Fail(path);
                    } finally { FindClose(handle); }
                }
            }
            if (!reparse && (attr & 1) != 0) {
                uint writable = attr & ~1u;
                if (!SetFileAttributesW(path, writable == 0 ? 0x80u : writable)) Fail(path);
            }
            if (!(directory ? RemoveDirectoryW(path) : DeleteFileW(path))) Fail(path);
        }
    }
}
'@ -ErrorAction Stop
    }
    [VaultGanttInstaller.NativeCleanup]::DeleteTree($Path)
    if ([VaultGanttInstaller.NativeCleanup]::Exists($Path)) { Stop-Installer "削除後もパスが存在します: $Path" }
}

function Remove-InstallerPath {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$OwnedRoot, [switch]$CloudStage)
    try {
        $full = Get-InstallerNormalizedPath $Path
        $owned = Get-InstallerNormalizedPath $OwnedRoot
        if (-not $script:InstallerOwnedDirectories.ContainsKey($owned) -or
            (-not $full.Equals($owned, [StringComparison]::OrdinalIgnoreCase) -and
             -not $full.StartsWith($owned + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
            Stop-Installer 'cleanup対象はこのinstallerが作成した作業フォルダー内に限定されます。'
        }
        if ($CloudStage -and (-not $full.Equals($owned, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($full) -cnotmatch '^\.vault-gantt-installer-[0-9a-f]{32}$')) {
            Stop-Installer 'クラウド上のcleanupはこの実行が作成したstageだけに限定されます。'
        }
        Assert-InstallerNoReparseChain $full -Strict:(-not $CloudStage)
        if (Test-Path -LiteralPath $full) {
            if ($CloudStage) {
                # A OneDrive stage may itself become a cloud directory. Remove only
                # known stage files, then delete the empty directory without traversing
                # any reparse point. WorkRoot/backup cleanup remains fully strict.
                $entries = @(Get-ChildItem -LiteralPath $full -Force -ErrorAction Stop)
                foreach ($entry in $entries) {
                    if ($entry.PSIsContainer -or ($entry.Name -cnotin $script:InstallerFiles -and
                        $entry.Name -cnotin @($script:InstallerFiles | ForEach-Object { 'restore-' + $_ }))) {
                        Stop-Installer "stageに想定外のファイルがあります: $($entry.FullName)"
                    }
                    Assert-InstallerSafeReparsePoint -Item $entry
                }
                foreach ($entry in $entries) { Remove-Item -LiteralPath $entry.FullName -Force -ErrorAction Stop }
                $stageItem = Get-Item -LiteralPath $full -Force -ErrorAction Stop
                Assert-InstallerSafeReparsePoint -Item $stageItem
                if (($stageItem.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
                    # OneDrive may mark our cloud stage read-only while syncing it.
                    # Clear only this owned directory's read-only bit, after tag validation.
                    [IO.File]::SetAttributes($full, [Enum]::ToObject([IO.FileAttributes], ([int]$stageItem.Attributes -band (-bnot 1))))
                }
            }
            Remove-InstallerTree -Path $full
        }
        if ($full.Equals($owned, [StringComparison]::OrdinalIgnoreCase)) { $script:InstallerOwnedDirectories.Remove($owned) }
    } catch {
        Write-Warning -Message "cleanupに失敗しました。残留パス: $Path ($($_.Exception.Message))" -WarningAction Continue
    }
}

function Install-BuiltFiles {
    param([string]$SourceDirectory, [string]$DestinationPath, [string]$WorkDirectory)
    Assert-BuiltFiles -SourceDirectory $SourceDirectory | Out-Null
    $destination = Resolve-InstallerDestination -DestinationPath $DestinationPath
    if (-not (Test-Path -LiteralPath $WorkDirectory -PathType Container)) { Stop-Installer "作業フォルダーがありません: $WorkDirectory" }

    $backup = Join-Path $WorkDirectory ("backup-" + [guid]::NewGuid().ToString('N'))
    $stage = Join-Path $destination (".vault-gantt-installer-" + [guid]::NewGuid().ToString('N'))
    $mutex = Enter-InstallerLock -DestinationPath $destination
    $original = @{}
    $originalHashes = @{}
    $installed = New-Object System.Collections.ArrayList
    $preserveBackup = $false
    $retainedBackup = $null
    try {
        # Revalidate identity inside the lock, before taking the backup.
        Resolve-InstallerDestination -DestinationPath $destination | Out-Null
        New-InstallerOwnedDirectory -Path $backup
        foreach ($name in $script:InstallerFiles) {
            $target = Join-Path $destination $name
            if (Test-Path -LiteralPath $target) {
                $item = Get-Item -LiteralPath $target -Force
                if ($item.PSIsContainer) { Stop-Installer "配置先の$nameがファイルではありません。" }
                Assert-InstallerSafeReparsePoint -Item $item
                $original[$name] = $true
                # Read the contents to hydrate cloud-only files before any destination writes.
                $bytes = Read-InstallerExistingFile -Path $target
                [System.IO.File]::WriteAllBytes((Join-Path $backup $name), $bytes)
                try { $sourceHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256 -ErrorAction Stop).Hash }
                catch { Stop-Installer "既存$nameのhashを読み込めません。OneDriveでこのフォルダを『このデバイス上に常に保持する』にしてから再実行してください。$($_.Exception.Message)" }
                $backupHash = (Get-FileHash -LiteralPath (Join-Path $backup $name) -Algorithm SHA256 -ErrorAction Stop).Hash
                $originalHashes[$name] = $sourceHash
                if ($sourceHash -cne $backupHash) { Stop-Installer "既存$nameのbackup検証に失敗しました。" }
            } else { $original[$name] = $false }
        }

        New-InstallerOwnedDirectory -Path $stage -AllowCloudAncestors
        foreach ($name in $script:InstallerFiles) {
            Copy-Item -LiteralPath (Join-Path $SourceDirectory $name) -Destination (Join-Path $stage $name) -ErrorAction Stop
            $sourceHash = (Get-FileHash -LiteralPath (Join-Path $SourceDirectory $name) -Algorithm SHA256 -ErrorAction Stop).Hash
            $stagedHash = (Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256 -ErrorAction Stop).Hash
            if ($sourceHash -cne $stagedHash) { Stop-Installer "配置前の$name検証に失敗しました。" }
        }

        foreach ($name in 'main.js', 'styles.css', 'manifest.json') {
            $stagedPath = Join-Path $stage $name
            $target = Join-Path $destination $name
            # Replace can throw after changing/removing the target (including error 1176).
            [void]$installed.Add($name)
            Move-InstallerFile -SourcePath $stagedPath -TargetPath $target -Replace $original[$name]
        }

        foreach ($name in $script:InstallerFiles) {
            $expected = (Get-FileHash -LiteralPath (Join-Path $SourceDirectory $name) -Algorithm SHA256 -ErrorAction Stop).Hash
            $actual = (Get-FileHash -LiteralPath (Join-Path $destination $name) -Algorithm SHA256 -ErrorAction Stop).Hash
            if ($expected -cne $actual) { throw "配置後の$name検証に失敗しました。" }
        }
        if (@($script:InstallerFiles | Where-Object { $original[$_] }).Count -gt 0) {
            $preserveBackup = $true
            $retainedBackup = $backup
        }
    } catch {
        $reason = $_.Exception.Message
        $rollbackErrors = @()
        for ($index = $installed.Count - 1; $index -ge 0; $index--) {
            $name = [string]$installed[$index]
            $target = Join-Path $destination $name
            try {
                if ($original[$name]) {
                    # A failed Replace may leave the original untouched and locked.
                    $unchanged = (Test-Path -LiteralPath $target -PathType Leaf) -and
                        ((Get-FileHash -LiteralPath $target -Algorithm SHA256 -ErrorAction Stop).Hash -ceq $originalHashes[$name])
                    if (-not $unchanged) {
                        $restorePath = Join-Path $stage ("restore-" + $name)
                        Restore-InstallerFile -Name $name -BackupDirectory $backup -TargetPath $target -RestorePath $restorePath
                    }
                } elseif (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force -ErrorAction Stop }
            } catch { $rollbackErrors += "$name`: $($_.Exception.Message)" }
        }
        # Verify every original file's original content AND absence, independent of restore success.
        foreach ($name in @($script:InstallerFiles | Where-Object { $installed.Count -gt 0 })) {
            $target = Join-Path $destination $name
            try {
                if ($original[$name]) {
                    if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or
                        (Get-FileHash -LiteralPath $target -Algorithm SHA256 -ErrorAction Stop).Hash -cne $originalHashes[$name]) {
                        throw '復元後のhashまたは存在状態が元と一致しません。'
                    }
                } elseif (Test-Path -LiteralPath $target) { throw '元は存在しなかったファイルが残っています。' }
            } catch { $rollbackErrors += "$name`: $($_.Exception.Message)" }
        }
        if ($rollbackErrors.Count -gt 0) {
            $preserveBackup = $true
            $failure = [System.InvalidOperationException]::new("配置に失敗しrollbackも不完全です。手動復元が必要です。backupの元ファイルを配置先へ戻し、元は存在しなかったファイルを取り除いてください。$reason / $($rollbackErrors -join '; ') backup: $backup WorkRoot: $WorkDirectory")
            $failure.Data['PreserveWorkRoot'] = $true
            throw $failure
        }
        Stop-Installer "配置に失敗したため既存ファイルを復元しました。$reason"
    } finally {
        try {
            if ($script:InstallerOwnedDirectories.ContainsKey($stage)) { Remove-InstallerPath -Path $stage -OwnedRoot $stage -CloudStage }
            if (-not $preserveBackup -and $script:InstallerOwnedDirectories.ContainsKey($backup)) { Remove-InstallerPath -Path $backup -OwnedRoot $backup }
        } finally {
            try { $mutex.ReleaseMutex() } finally { $mutex.Dispose() }
        }
    }
    return $retainedBackup
}

function Invoke-VaultGanttInstaller {
    param([string]$Branch, [string]$DestinationPath, [string]$WorkRoot)
    $tools = Get-InstallerToolPaths
    Assert-InstallerPreflight -ToolPaths $tools
    $branches = @(Get-PublicBranches -GitPath $tools.Git)
    Write-Host '公開ブランチ一覧:'
    for ($i = 0; $i -lt $branches.Count; $i++) {
        Write-Host ("{0}. {1} [{2}]" -f ($i + 1), $branches[$i].Branch, $branches[$i].Sha.Substring(0, 12))
    }
    $selected = Resolve-PublicBranch -Branches $branches -Branch $Branch
    $destination = Resolve-InstallerDestination -DestinationPath $DestinationPath

    if (-not $WorkRoot) { $WorkRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vault-gantt-installer-" + [guid]::NewGuid().ToString('N')) }
    else { $WorkRoot = [System.IO.Path]::GetFullPath($WorkRoot) }
    if (Test-Path -LiteralPath $WorkRoot) { Stop-Installer "作業フォルダーが既に存在します: $WorkRoot" }
    New-InstallerOwnedDirectory -Path $WorkRoot
    $preserveWorkRoot = $false
    try {
        $repository = Join-Path $WorkRoot 'repository'
        New-Item -ItemType Directory -Path $repository | Out-Null
        Invoke-NativeStrict -FilePath $tools.Git -Arguments @('init') -WorkingDirectory $repository -Operation 'git init' | Out-Null
        Invoke-NativeStrict -FilePath $tools.Git -Arguments @('remote', 'add', 'origin', $script:InstallerRepositoryUrl) -WorkingDirectory $repository -Operation 'git remote add' | Out-Null
        Invoke-NativeStrict -FilePath $tools.Git -Arguments @('fetch', '--depth', '1', '--no-tags', 'origin', $selected.Sha) -WorkingDirectory $repository -Operation 'git fetch' | Out-Null
        Invoke-NativeStrict -FilePath $tools.Git -Arguments @('checkout', '--detach', $selected.Sha) -WorkingDirectory $repository -Operation 'git checkout' | Out-Null
        $head = ((Invoke-NativeStrict -FilePath $tools.Git -Arguments @('rev-parse', 'HEAD') -WorkingDirectory $repository -Operation 'git rev-parse' -CaptureOutput) -join '').Trim().ToLowerInvariant()
        if ($head -cne $selected.Sha) { Stop-Installer "checkoutしたcommitが選択時のSHAと一致しません (expected=$($selected.Sha), actual=$head)" }

        Write-Host "branch $($selected.Branch) / commit $($selected.Sha) を固定しました。"
        Invoke-NativeStrict -FilePath $tools.Npm -Arguments @('ci') -WorkingDirectory $repository -Operation 'npm ci' | Out-Null
        Invoke-NativeStrict -FilePath $tools.Npm -Arguments @('run', 'build') -WorkingDirectory $repository -Operation 'npm run build' | Out-Null
        $version = Assert-BuiltFiles -SourceDirectory $repository
        $backupPath = Install-BuiltFiles -SourceDirectory $repository -DestinationPath $destination -WorkDirectory $WorkRoot
        Write-Host "配置が完了しました: $destination (version $version)"
        if ($backupPath) {
            $preserveWorkRoot = $true
            Remove-InstallerPath -Path $repository -OwnedRoot $WorkRoot
            Write-Host "既存ファイルbackupを保持しています: $backupPath"
        }
    } catch {
        if ($_.Exception.Data.Contains('PreserveWorkRoot')) { $preserveWorkRoot = [bool]$_.Exception.Data['PreserveWorkRoot'] }
        throw
    } finally {
        if ($preserveWorkRoot) { Write-Host "作業フォルダーを保持しています: $WorkRoot" }
        else { Remove-InstallerPath -Path $WorkRoot -OwnedRoot $WorkRoot }
    }
}
