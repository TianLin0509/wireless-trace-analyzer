Set-StrictMode -Version 2.0

function Get-DefaultOfflineUpdateStateRoot {
    if (-not $env:LOCALAPPDATA) {
        throw "无法确定 LOCALAPPDATA，不能创建更新备份。"
    }
    return (Join-Path $env:LOCALAPPDATA "WirelessTraceAnalyzer\offline-updates")
}

function Convert-ToSafeRelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $candidate = ($Path -replace "/", "\").Trim()
    if (-not $candidate) { throw "更新清单包含空路径。" }
    if ([IO.Path]::IsPathRooted($candidate) -or $candidate.StartsWith("\")) {
        throw "更新清单包含绝对路径：$Path"
    }
    $parts = @($candidate.Split("\"))
    if ($parts.Count -eq 0 -or $parts -contains "" -or $parts -contains "." -or $parts -contains "..") {
        throw "更新清单包含不安全路径：$Path"
    }
    foreach ($part in $parts) {
        if ($part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
            throw "更新清单包含非法路径：$Path"
        }
    }
    return [string]::Join("\", $parts)
}

function Resolve-SafeChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $safeRelative = Convert-ToSafeRelativePath $RelativePath
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\")
    $childFull = [IO.Path]::GetFullPath((Join-Path $rootFull $safeRelative))
    $prefix = $rootFull + "\"
    if (-not $childFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "更新路径越过安装目录：$RelativePath"
    }
    return $childFull
}

function Get-InstalledVersion {
    param([Parameter(Mandatory = $true)][string]$TargetRoot)

    $versionFile = Join-Path $TargetRoot "VERSION"
    if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) {
        throw "目标目录不是有效安装目录，缺少 VERSION：$TargetRoot"
    }
    return (Get-Content -LiteralPath $versionFile -Encoding UTF8 -TotalCount 1).Trim()
}

function Select-OfflinePatchZip {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = "选择从 GitHub 下载的增量更新包"
        $dialog.Filter = "增量更新包 (*.zip)|*.zip|所有文件 (*.*)|*.*"
        $downloads = Join-Path $env:USERPROFILE "Downloads"
        if (Test-Path -LiteralPath $downloads) { $dialog.InitialDirectory = $downloads }
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            return $dialog.FileName
        }
        return $null
    } catch {
        $value = Read-Host "请输入从 GitHub 下载的增量更新 ZIP 完整路径（留空取消）"
        if (-not $value) { return $null }
        return $value.Trim().Trim('"')
    }
}

function Select-OfflineInstallRoot {
    param([string]$SuggestedRoot)

    if ($SuggestedRoot -and (Test-Path -LiteralPath (Join-Path $SuggestedRoot "VERSION") -PathType Leaf)) {
        return $SuggestedRoot
    }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "选择 Wireless Trace Analyzer 的安装目录（目录内应有 VERSION）"
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            return $dialog.SelectedPath
        }
        return $null
    } catch {
        $value = Read-Host "请输入 Wireless Trace Analyzer 安装目录（留空取消）"
        if (-not $value) { return $null }
        return $value.Trim().Trim('"')
    }
}

function Expand-OfflinePatchArchive {
    param([Parameter(Mandatory = $true)][string]$PatchZip)

    $zipPath = [IO.Path]::GetFullPath($PatchZip)
    if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
        throw "增量更新包不存在：$zipPath"
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("wireless-trace-patch-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            foreach ($entry in $archive.Entries) {
                if (-not $entry.FullName) { continue }
                $entryPath = ($entry.FullName -replace "/", "\").TrimEnd("\")
                if (-not $entryPath) { continue }
                [void](Resolve-SafeChildPath -Root $tempRoot -RelativePath $entryPath)
            }
        } finally {
            $archive.Dispose()
        }
        [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $tempRoot)
        $manifests = @(Get-ChildItem -LiteralPath $tempRoot -Recurse -File -Filter "update-manifest.json")
        if ($manifests.Count -ne 1) {
            throw "更新包格式错误：应且只能包含一个 update-manifest.json。"
        }
        return [pscustomobject]@{
            patch_root = $manifests[0].Directory.FullName
            temp_root = $tempRoot
        }
    } catch {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
        throw
    }
}

function Read-OfflinePatchManifest {
    param([Parameter(Mandatory = $true)][string]$PatchRoot)

    $manifestPath = Join-Path $PatchRoot "update-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "更新包缺少 update-manifest.json。"
    }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "更新清单不是有效 JSON：$($_.Exception.Message)"
    }
    foreach ($name in @("schema_version", "from_version", "to_version", "files", "delete")) {
        if ($manifest.PSObject.Properties.Name -notcontains $name) {
            throw "更新清单缺少字段：$name"
        }
    }
    if ([int]$manifest.schema_version -ne 1) {
        throw "不支持的更新清单版本：$($manifest.schema_version)"
    }
    if (-not [string]$manifest.from_version -or -not [string]$manifest.to_version) {
        throw "更新清单的起止版本不能为空。"
    }
    return $manifest
}

function Test-OfflinePatchPayload {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$PatchRoot
    )

    $payloadRoot = Join-Path $PatchRoot "payload"
    if (-not (Test-Path -LiteralPath $payloadRoot -PathType Container)) {
        throw "更新包缺少 payload 目录。"
    }
    $seen = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($Manifest.files)) {
        foreach ($name in @("path", "sha256", "size")) {
            if ($entry.PSObject.Properties.Name -notcontains $name) {
                throw "更新文件条目缺少字段：$name"
            }
        }
        $relative = Convert-ToSafeRelativePath ([string]$entry.path)
        if (-not $seen.Add($relative)) { throw "更新清单包含重复路径：$relative" }
        $payloadPath = Resolve-SafeChildPath -Root $payloadRoot -RelativePath $relative
        if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf)) {
            throw "更新包缺少文件：$relative"
        }
        $actualHash = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash
        if ($actualHash -ne ([string]$entry.sha256).ToUpperInvariant()) {
            throw "更新文件校验失败：$relative"
        }
        $actualSize = (Get-Item -LiteralPath $payloadPath).Length
        if ([int64]$actualSize -ne [int64]$entry.size) {
            throw "更新文件大小不符：$relative"
        }
    }
    foreach ($relativeValue in @($Manifest.delete)) {
        $relative = Convert-ToSafeRelativePath ([string]$relativeValue)
        if (-not $seen.Add($relative)) { throw "同一路径不能同时更新和删除：$relative" }
    }
    if (@($Manifest.files).Count -eq 0 -and @($Manifest.delete).Count -eq 0) {
        throw "更新包不包含任何文件变化。"
    }
    if (-not $seen.Contains("VERSION")) {
        throw "更新包必须包含 VERSION，以保证版本状态最后提交。"
    }
}

function Write-JsonUtf8 {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $json = $Value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Restore-OfflineBackupRecord {
    param([Parameter(Mandatory = $true)][string]$RecordPath)

    $record = Get-Content -LiteralPath $RecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $targetRoot = [string]$record.target_root
    $backupRoot = Split-Path -Parent $RecordPath
    $backupFiles = Join-Path $backupRoot "files"
    foreach ($entry in @($record.entries)) {
        $relative = Convert-ToSafeRelativePath ([string]$entry.path)
        $targetPath = Resolve-SafeChildPath -Root $targetRoot -RelativePath $relative
        if ([bool]$entry.existed) {
            $sourcePath = Resolve-SafeChildPath -Root $backupFiles -RelativePath $relative
            if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
                throw "回退备份缺少文件：$relative"
            }
            $parent = Split-Path -Parent $targetPath
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
        } elseif (Test-Path -LiteralPath $targetPath -PathType Leaf) {
            Remove-Item -LiteralPath $targetPath -Force
        }
    }
    return $record
}

function Invoke-OfflinePatch {
    [CmdletBinding(DefaultParameterSetName = "Directory")]
    param(
        [Parameter(Mandatory = $true, ParameterSetName = "Archive")][string]$PatchZip,
        [Parameter(Mandatory = $true, ParameterSetName = "Directory")][string]$PatchDirectory,
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [string]$StateRoot,
        [switch]$NonInteractive,
        [switch]$AllowVersionMismatch
    )

    $target = [IO.Path]::GetFullPath($TargetRoot)
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        throw "安装目录不存在：$target"
    }
    if (-not $StateRoot) { $StateRoot = Get-DefaultOfflineUpdateStateRoot }
    $expanded = $null
    $patchRoot = $null
    try {
        if ($PSCmdlet.ParameterSetName -eq "Archive") {
            $expanded = Expand-OfflinePatchArchive -PatchZip $PatchZip
            $patchRoot = $expanded.patch_root
        } else {
            $patchRoot = [IO.Path]::GetFullPath($PatchDirectory)
        }
        $manifest = Read-OfflinePatchManifest -PatchRoot $patchRoot
        Test-OfflinePatchPayload -Manifest $manifest -PatchRoot $patchRoot

        $currentVersion = Get-InstalledVersion -TargetRoot $target
        $fromVersion = [string]$manifest.from_version
        $toVersion = [string]$manifest.to_version
        if (-not $AllowVersionMismatch -and $currentVersion -ne $fromVersion) {
            throw "补丁版本不匹配：当前为 $currentVersion，此补丁要求 $fromVersion。请下载与当前版本对应的补丁。"
        }
        if ($currentVersion -eq $toVersion) {
            throw "当前已经是 $toVersion，无需重复安装。"
        }
        if (-not $NonInteractive) {
            $answer = Read-Host "确认将 $currentVersion 更新到 $toVersion？输入 Y 继续"
            if ($answer -notmatch "^[Yy]$") {
                Write-Host "已取消更新。"
                return $null
            }
        }

        New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backupRoot = Join-Path $StateRoot ("backup-{0}-{1}-to-{2}" -f $stamp, ($currentVersion -replace "[^0-9A-Za-z._-]", "_"), ($toVersion -replace "[^0-9A-Za-z._-]", "_"))
        if (Test-Path -LiteralPath $backupRoot) { $backupRoot += "-" + [guid]::NewGuid().ToString("N").Substring(0, 8) }
        $backupFiles = Join-Path $backupRoot "files"
        New-Item -ItemType Directory -Path $backupFiles -Force | Out-Null

        $paths = New-Object "System.Collections.Generic.List[string]"
        foreach ($entry in @($manifest.files)) { $paths.Add((Convert-ToSafeRelativePath ([string]$entry.path))) }
        foreach ($entry in @($manifest.delete)) { $paths.Add((Convert-ToSafeRelativePath ([string]$entry))) }
        $uniquePaths = @($paths | Sort-Object -Unique)
        $backupEntries = @()
        foreach ($relative in $uniquePaths) {
            $targetPath = Resolve-SafeChildPath -Root $target -RelativePath $relative
            $existed = Test-Path -LiteralPath $targetPath -PathType Leaf
            $backupEntries += [ordered]@{ path = ($relative -replace "\\", "/"); existed = [bool]$existed }
            if ($existed) {
                $backupPath = Resolve-SafeChildPath -Root $backupFiles -RelativePath $relative
                New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force | Out-Null
                Copy-Item -LiteralPath $targetPath -Destination $backupPath -Force
            }
        }
        $record = [ordered]@{
            schema_version = 1
            created_at = (Get-Date).ToString("o")
            target_root = $target
            from_version = $currentVersion
            to_version = $toVersion
            entries = $backupEntries
        }
        $recordPath = Join-Path $backupRoot "backup-record.json"
        Write-JsonUtf8 -Value $record -Path $recordPath

        try {
            $payloadRoot = Join-Path $patchRoot "payload"
            $orderedFiles = @($manifest.files | Sort-Object @{ Expression = { if ((Convert-ToSafeRelativePath ([string]$_.path)) -eq "VERSION") { 1 } else { 0 } } })
            foreach ($entry in $orderedFiles) {
                $relative = Convert-ToSafeRelativePath ([string]$entry.path)
                $sourcePath = Resolve-SafeChildPath -Root $payloadRoot -RelativePath $relative
                $targetPath = Resolve-SafeChildPath -Root $target -RelativePath $relative
                New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
                Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
            }
            foreach ($relativeValue in @($manifest.delete)) {
                $relative = Convert-ToSafeRelativePath ([string]$relativeValue)
                $targetPath = Resolve-SafeChildPath -Root $target -RelativePath $relative
                if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
                    Remove-Item -LiteralPath $targetPath -Force
                }
            }
            foreach ($entry in @($manifest.files)) {
                $relative = Convert-ToSafeRelativePath ([string]$entry.path)
                $targetPath = Resolve-SafeChildPath -Root $target -RelativePath $relative
                $actualHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
                if ($actualHash -ne ([string]$entry.sha256).ToUpperInvariant()) {
                    throw "更新后校验失败：$relative"
                }
            }
            foreach ($relativeValue in @($manifest.delete)) {
                $targetPath = Resolve-SafeChildPath -Root $target -RelativePath ([string]$relativeValue)
                if (Test-Path -LiteralPath $targetPath) { throw "废弃文件删除失败：$relativeValue" }
            }
            $installedVersion = Get-InstalledVersion -TargetRoot $target
            if ($installedVersion -ne $toVersion) {
                throw "VERSION 更新失败：期望 $toVersion，实际 $installedVersion"
            }
        } catch {
            try { [void](Restore-OfflineBackupRecord -RecordPath $recordPath) } catch {}
            throw "增量更新失败，已尝试自动恢复原文件。原因：$($_.Exception.Message)"
        }

        Set-Content -LiteralPath (Join-Path $StateRoot "last-backup.txt") -Value $recordPath -Encoding ASCII
        Write-Host ("增量更新完成：{0} -> {1}；替换 {2} 个文件，删除 {3} 个文件。" -f $currentVersion, $toVersion, @($manifest.files).Count, @($manifest.delete).Count) -ForegroundColor Green
        Write-Host "文件级备份：$backupRoot"
        return [pscustomobject]@{
            from_version = $currentVersion
            to_version = $toVersion
            files_updated = @($manifest.files).Count
            files_deleted = @($manifest.delete).Count
            backup_root = $backupRoot
            target_root = $target
        }
    } finally {
        if ($expanded -and (Test-Path -LiteralPath $expanded.temp_root)) {
            Remove-Item -LiteralPath $expanded.temp_root -Recurse -Force
        }
    }
}

function Get-OfflineRollbackInfo {
    param([string]$StateRoot)

    if (-not $StateRoot) { $StateRoot = Get-DefaultOfflineUpdateStateRoot }
    $pointer = Join-Path $StateRoot "last-backup.txt"
    if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) {
        throw "没有可回退记录。至少成功应用一次增量更新后才可回退。"
    }
    $recordPath = (Get-Content -LiteralPath $pointer -Encoding ASCII -TotalCount 1).Trim()
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
        throw "回退记录指向的备份不存在：$recordPath"
    }
    $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return [pscustomobject]@{ pointer = $pointer; record_path = $recordPath; record = $record }
}

function Invoke-OfflineRollback {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [string]$StateRoot,
        [switch]$NonInteractive
    )

    if (-not $StateRoot) { $StateRoot = Get-DefaultOfflineUpdateStateRoot }
    $info = Get-OfflineRollbackInfo -StateRoot $StateRoot
    $target = [IO.Path]::GetFullPath($TargetRoot)
    $recordTarget = [IO.Path]::GetFullPath([string]$info.record.target_root)
    if ($target -ne $recordTarget) {
        throw "最近备份属于其他安装目录：$recordTarget"
    }
    $currentVersion = Get-InstalledVersion -TargetRoot $target
    if (-not $NonInteractive) {
        $answer = Read-Host "确认从 $currentVersion 回退到 $($info.record.from_version)？输入 Y 继续"
        if ($answer -notmatch "^[Yy]$") {
            Write-Host "已取消回退。"
            return $null
        }
    }
    $record = Restore-OfflineBackupRecord -RecordPath $info.record_path
    $restoredVersion = Get-InstalledVersion -TargetRoot $target
    if ($restoredVersion -ne [string]$record.from_version) {
        throw "回退后版本校验失败：期望 $($record.from_version)，实际 $restoredVersion"
    }
    Remove-Item -LiteralPath $info.pointer -Force
    Set-Content -LiteralPath (Join-Path $StateRoot "last-rollback.txt") -Value $info.record_path -Encoding ASCII
    Write-Host "已回退：$currentVersion -> $restoredVersion" -ForegroundColor Green
    return [pscustomobject]@{
        from_version = $currentVersion
        to_version = $restoredVersion
        target_root = $target
        backup_record = $info.record_path
    }
}
