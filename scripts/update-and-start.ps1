param(
    [string]$PatchZip,
    [switch]$Check,
    [switch]$ApplyOnly,
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
. (Join-Path $PSScriptRoot "offline-update-core.ps1")

if ($Check) {
    Write-Host "UPDATE_CHECK_OK mode=github-browser-download version=$script:Version"
    return
}

if (-not $PatchZip) {
    if ($NonInteractive) {
        throw "非交互模式必须通过 -PatchZip 指定增量更新包。"
    }
    $PatchZip = Select-OfflinePatchZip
    if (-not $PatchZip) {
        Write-Host "未选择更新包，已取消。"
        return
    }
}

$result = Invoke-OfflinePatch `
    -PatchZip $PatchZip `
    -TargetRoot $script:RepoRoot `
    -StateRoot (Join-Path $script:RuntimeRoot "offline-updates") `
    -NonInteractive:$NonInteractive

if (-not $result) { return }
$script:Version = $result.to_version
if ($ApplyOnly) {
    Write-Host "UPDATE_ONLY_OK version=$script:Version files=$($result.files_updated)"
    return
}

Start-Analyzer
