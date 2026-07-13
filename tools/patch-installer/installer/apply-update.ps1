param(
    [string]$TargetRoot,
    [switch]$NonInteractive,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "offline-update-core.ps1")

$patchRoot = Split-Path -Parent $PSScriptRoot
if (-not $TargetRoot) {
    if ($NonInteractive) {
        throw "非交互模式必须通过 -TargetRoot 指定安装目录。"
    }
    $suggested = Join-Path $env:USERPROFILE "wireless-trace-analyzer"
    $TargetRoot = Select-OfflineInstallRoot -SuggestedRoot $suggested
    if (-not $TargetRoot) {
        Write-Host "未选择安装目录，已取消。"
        return
    }
}

$result = Invoke-OfflinePatch `
    -PatchDirectory $patchRoot `
    -TargetRoot $TargetRoot `
    -NonInteractive:$NonInteractive

if (-not $result -or $NoStart) { return }
$launcher = Join-Path $TargetRoot "仅启动.cmd"
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
    Start-Process -FilePath $launcher -WorkingDirectory $TargetRoot
} else {
    Write-Host "更新已完成，但未找到启动入口：$launcher"
}
