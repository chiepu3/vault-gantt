# Shared reparse helpers. The artifact updater retains its existing attribute policy.
Set-StrictMode -Version 2.0

# FindFirstFileW reports the tag without opening/hydrating cloud file contents.
# Unicode and extended paths preserve Japanese names and support long paths.
function Get-VaultGanttReparseTag {
    param([string]$Path)
    if (-not ('VaultGantt.PathSafety' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace VaultGantt {
    public static class PathSafety {
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
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool FindClose(IntPtr handle);
        public static uint GetReparseTag(string path) {
            path = System.IO.Path.GetFullPath(path);
            if (!path.StartsWith(@"\\?\")) {
                path = path.StartsWith(@"\\") ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
            }
            FindData data;
            IntPtr handle = FindFirstFileW(path, out data);
            if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { return (data.Attributes & 0x400u) != 0 ? data.Reserved0 : 0u; }
            finally { FindClose(handle); }
        }
    }
}
'@ -ErrorAction Stop
    }
    return [VaultGantt.PathSafety]::GetReparseTag($Path)
}

function Test-VaultGanttCloudReparseTag {
    param([uint32]$Tag)
    # IO_REPARSE_TAG_CLOUD and CLOUD_1..F: only bits 12..15 vary.
    # Do not accept other tags merely because they carry cloud file attributes.
    return (($Tag -band [uint32]4294905855) -eq [uint32]2415919130) # 0xFFFF0FFF / 0x9000001A
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

