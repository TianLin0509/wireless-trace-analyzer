param([switch]$Check)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "未找到 Git。请安装 Git for Windows 后重试。"
}
if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot ".git"))) {
    throw "当前目录不是 Git 仓库，请通过 GitHub clone 获取项目。"
}

Push-Location $script:RepoRoot
try {
    $remote = (git remote get-url origin 2>$null).Trim()
    if (-not $remote) { throw "未配置 origin 远程仓库。" }
    if ($Check) {
        Start-Analyzer -CheckOnly
        Write-Host "UPDATE_CHECK_OK origin=$remote"
        return
    }

    $changes = @(git status --porcelain --untracked-files=normal)
    if ($changes.Count -gt 0) {
        throw "检测到本地代码改动，已停止更新以避免覆盖。请先提交、备份或还原这些改动。"
    }

    $before = (git rev-parse HEAD).Trim()
    Write-Info "正在从 GitHub 获取增量更新。"
    git fetch --prune origin main
    if ($LASTEXITCODE -ne 0) { throw "GitHub fetch 失败，请检查网络或登录状态。" }
    git merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) { throw "无法快进更新，已保留当前版本不变。" }
    $after = (git rev-parse HEAD).Trim()

    if ($before -ne $after) {
        New-Item -ItemType Directory -Path $script:RuntimeRoot -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:RuntimeRoot "previous_commit.txt") -Value $before -Encoding ASCII
        Write-Info "更新完成：$($before.Substring(0, 8)) -> $($after.Substring(0, 8))"
    } else {
        Write-Info "当前已经是 GitHub 最新版本。"
    }
} finally {
    Pop-Location
}

Start-Analyzer

