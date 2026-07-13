param([switch]$Check, [switch]$Force)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$stateFile = Join-Path $script:RuntimeRoot "previous_commit.txt"
if ($Check) {
    Write-Host "ROLLBACK_CHECK_OK state=$stateFile"
    return
}
if (-not (Test-Path -LiteralPath $stateFile)) {
    throw "没有可回退记录。至少成功更新一次后才会生成上一版本记录。"
}

Push-Location $script:RepoRoot
try {
    $changes = @(git status --porcelain --untracked-files=normal)
    if ($changes.Count -gt 0) { throw "检测到本地代码改动，已停止回退。" }
    $previous = (Get-Content -LiteralPath $stateFile -Encoding ASCII -TotalCount 1).Trim()
    git cat-file -e "$previous`^{commit}"
    if ($LASTEXITCODE -ne 0) { throw "上一版本提交在本地不存在，请先联网执行 git fetch。" }
    $current = (git rev-parse HEAD).Trim()
    if (-not $Force) {
        $answer = Read-Host "确认从 $($current.Substring(0, 8)) 回退到 $($previous.Substring(0, 8))？输入 Y 继续"
        if ($answer -notmatch '^[Yy]$') { Write-Host "已取消回退。"; return }
    }
    git reset --hard $previous
    if ($LASTEXITCODE -ne 0) { throw "Git 回退失败。" }
    Write-Info "已回退到 $($previous.Substring(0, 8))。下次更新可重新快进到 main 最新版。"
} finally {
    Pop-Location
}

Start-Analyzer

