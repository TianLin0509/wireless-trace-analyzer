param(
    [string]$FromRef,
    [string]$ToRef = "HEAD",
    [string]$OutputDir
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $repoRoot "dist" }

function Invoke-GitText {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $lines = @(& git @Arguments)
    if ($LASTEXITCODE -ne 0) { throw "git 命令失败：git $($Arguments -join ' ')" }
    return $lines
}

function Get-VersionAtRef {
    param([string]$Ref)
    $lines = @(Invoke-GitText show "$Ref`:VERSION")
    if ($lines.Count -lt 1) { throw "无法从 $Ref 读取 VERSION。" }
    return ([string]$lines[0]).Trim()
}

function Test-RuntimePath {
    param([string]$Path)
    $value = ($Path -replace "\\", "/").TrimStart("/")
    foreach ($prefix in @(".github/", "tests/", "tools/")) {
        if ($value.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    }
    if ($value -in @(".gitattributes", ".gitignore", "requirements-dev.txt")) { return $false }
    return $true
}

function Convert-ToAssetVersion {
    param([string]$Version)
    return ($Version.Trim() -replace "[^0-9A-Za-z._-]", "-")
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "构建发布包需要 Git。" }
Push-Location $repoRoot
try {
    $changes = @(git status --porcelain --untracked-files=normal)
    if ($changes.Count -gt 0) { throw "工作区存在未提交改动，拒绝构建不可复现的发布包。" }

    $headLines = @(Invoke-GitText rev-parse HEAD)
    $toLines = @(Invoke-GitText rev-parse $ToRef)
    $headCommit = ([string]$headLines[0]).Trim()
    $toCommit = ([string]$toLines[0]).Trim()
    if ($headCommit -ne $toCommit) {
        throw "构建脚本要求 ToRef 指向当前 HEAD，以确保安装器模板与发布内容一致。"
    }
    if (-not $FromRef) {
        $previous = @(Invoke-GitText describe --tags --abbrev=0 "$ToRef^")
        if ($previous.Count -lt 1) { throw "无法自动确定上一个版本 tag，请通过 -FromRef 指定。" }
        $FromRef = ([string]$previous[0]).Trim()
    }
    [void](Invoke-GitText rev-parse $FromRef)

    $fromVersion = Get-VersionAtRef $FromRef
    $toVersion = Get-VersionAtRef $ToRef
    if ($fromVersion -eq $toVersion) { throw "起止版本相同：$fromVersion" }
    $fromAsset = Convert-ToAssetVersion $fromVersion
    $toAsset = Convert-ToAssetVersion $toVersion

    $outputFull = [IO.Path]::GetFullPath($OutputDir)
    $repoFull = [IO.Path]::GetFullPath($repoRoot).TrimEnd("\")
    if (-not $outputFull.StartsWith($repoFull + "\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "OutputDir 必须位于仓库内，避免清理到外部目录：$outputFull"
    }
    if (Test-Path -LiteralPath $outputFull) { Remove-Item -LiteralPath $outputFull -Recurse -Force }
    New-Item -ItemType Directory -Path $outputFull -Force | Out-Null

    $fullZip = Join-Path $outputFull ("wireless-trace-analyzer-{0}-full.zip" -f $toAsset)
    & git archive --format=zip "--prefix=wireless-trace-analyzer/" -o $fullZip $ToRef
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fullZip)) { throw "完整包构建失败。" }

    $payloadPaths = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
    $deletePaths = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
    $diffLines = @(Invoke-GitText -c core.quotepath=false diff --name-status --find-renames $FromRef $ToRef)
    foreach ($line in $diffLines) {
        if (-not $line) { continue }
        $parts = @(([string]$line) -split "`t")
        if ($parts.Count -lt 2) { throw "无法解析 git diff 行：$line" }
        $status = [string]$parts[0]
        if ($status.StartsWith("R") -or $status.StartsWith("C")) {
            if ($parts.Count -lt 3) { throw "无法解析重命名行：$line" }
            $oldPath = ([string]$parts[1]) -replace "\\", "/"
            $newPath = ([string]$parts[2]) -replace "\\", "/"
            if (Test-RuntimePath $oldPath) { [void]$deletePaths.Add($oldPath) }
            if (Test-RuntimePath $newPath) { [void]$payloadPaths.Add($newPath) }
        } elseif ($status.StartsWith("D")) {
            $path = ([string]$parts[1]) -replace "\\", "/"
            if (Test-RuntimePath $path) { [void]$deletePaths.Add($path) }
        } else {
            $path = ([string]$parts[1]) -replace "\\", "/"
            if (Test-RuntimePath $path) { [void]$payloadPaths.Add($path) }
        }
    }
    foreach ($path in @($deletePaths)) {
        if ($payloadPaths.Contains($path)) { [void]$deletePaths.Remove($path) }
    }
    if (-not $payloadPaths.Contains("VERSION")) { throw "版本发生变化时，差分包必须包含 VERSION。" }

    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("wireless-trace-release-" + [guid]::NewGuid().ToString("N"))
    $stageRoot = Join-Path $tempRoot "patch"
    $payloadRoot = Join-Path $stageRoot "payload"
    try {
        New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
        $payloadArchive = Join-Path $tempRoot "payload.zip"
        $payloadArgs = @($payloadPaths | Sort-Object)
        & git archive --format=zip -o $payloadArchive $ToRef -- @payloadArgs
        if ($LASTEXITCODE -ne 0) { throw "差分 payload 构建失败。" }
        Expand-Archive -LiteralPath $payloadArchive -DestinationPath $payloadRoot -Force

        Copy-Item -LiteralPath (Join-Path $repoRoot "tools\patch-installer\安装此更新.cmd") -Destination (Join-Path $stageRoot "安装此更新.cmd") -Force
        $installerRoot = Join-Path $stageRoot "installer"
        New-Item -ItemType Directory -Path $installerRoot -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repoRoot "tools\patch-installer\installer\apply-update.ps1") -Destination (Join-Path $installerRoot "apply-update.ps1") -Force
        Copy-Item -LiteralPath (Join-Path $repoRoot "scripts\offline-update-core.ps1") -Destination (Join-Path $installerRoot "offline-update-core.ps1") -Force

        $fileEntries = @()
        foreach ($relative in @($payloadPaths | Sort-Object)) {
            $payloadFile = Join-Path $payloadRoot ($relative -replace "/", "\")
            $fileEntries += [ordered]@{
                path = $relative
                sha256 = (Get-FileHash -LiteralPath $payloadFile -Algorithm SHA256).Hash
                size = (Get-Item -LiteralPath $payloadFile).Length
            }
        }
        $manifest = [ordered]@{
            schema_version = 1
            from_version = $fromVersion
            to_version = $toVersion
            generated_at_utc = [DateTime]::UtcNow.ToString("o")
            files = $fileEntries
            delete = @($deletePaths | Sort-Object)
        }
        $manifestJson = $manifest | ConvertTo-Json -Depth 8
        [IO.File]::WriteAllText((Join-Path $stageRoot "update-manifest.json"), $manifestJson, (New-Object Text.UTF8Encoding($false)))

        $instructions = @"
Wireless Trace Analyzer 增量更新 $fromVersion -> $toVersion

推荐方式：不要解压本 ZIP。双击已安装目录中的“更新并启动.cmd”，选择本 ZIP。
旧版过渡：如果当前安装目录中的更新器仍依赖 Git，可解压本 ZIP，再双击“安装此更新.cmd”。

本补丁只包含清单中的变化文件。安装器会验证版本与 SHA256，备份受影响文件后再覆盖。
"@
        [IO.File]::WriteAllText((Join-Path $stageRoot "更新说明.txt"), $instructions, (New-Object Text.UTF8Encoding($true)))

        $patchZip = Join-Path $outputFull ("wireless-trace-analyzer-{0}-to-{1}-patch.zip" -f $fromAsset, $toAsset)
        Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $patchZip -CompressionLevel Optimal

        $assets = @($fullZip, $patchZip)
        $sumLines = foreach ($asset in $assets) {
            "{0}  {1}" -f (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash, (Split-Path -Leaf $asset)
        }
        $sumPath = Join-Path $outputFull "SHA256SUMS.txt"
        [IO.File]::WriteAllLines($sumPath, $sumLines, (New-Object Text.UTF8Encoding($false)))

        Write-Host "RELEASE_PACKAGES_OK from=$fromVersion to=$toVersion"
        Write-Host "FULL=$fullZip"
        Write-Host "PATCH=$patchZip"
        Write-Host "CHANGED=$($payloadPaths.Count) DELETED=$($deletePaths.Count)"
    } finally {
        if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
    }
} finally {
    Pop-Location
}
