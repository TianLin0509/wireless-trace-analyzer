$ErrorActionPreference = "Stop"

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Version = (Get-Content -LiteralPath (Join-Path $script:RepoRoot "VERSION") -Encoding UTF8 -TotalCount 1).Trim()
$script:Port = if ($env:TRACE_PORT) { [int]$env:TRACE_PORT } else { 3004 }
$script:Url = "http://127.0.0.1:$script:Port"
$script:RuntimeRoot = Join-Path $env:LOCALAPPDATA "WirelessTraceAnalyzer"

function Write-Info([string]$Message) {
    Write-Host "[Trace] $Message" -ForegroundColor Cyan
}

function Get-BootstrapPythonMode {
    if (Get-Command py -ErrorAction SilentlyContinue) { return "py" }
    if (Get-Command python -ErrorAction SilentlyContinue) { return "python" }
    throw "未找到 Python 3。请先安装 Python 3，然后重新双击启动文件。"
}

$script:BootstrapPythonMode = Get-BootstrapPythonMode
$script:VenvRoot = Join-Path $script:RuntimeRoot "venv"
$script:VenvPython = Join-Path $script:VenvRoot "Scripts\python.exe"

function Invoke-BootstrapPython {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($script:BootstrapPythonMode -eq "py") {
            & py -3 @Arguments
        } else {
            & python @Arguments
        }
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Invoke-AppPython {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $script:VenvPython @Arguments
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Ensure-VirtualEnvironment {
    if (Test-Path -LiteralPath $script:VenvPython) { return }
    New-Item -ItemType Directory -Path $script:RuntimeRoot -Force | Out-Null
    Write-Info "正在创建本工具专用 Python 虚拟环境，不会修改系统 Python。"
    Invoke-BootstrapPython -m venv $script:VenvRoot
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $script:VenvPython)) {
        throw "Python 虚拟环境创建失败。"
    }
}

function Ensure-Dependencies {
    Ensure-VirtualEnvironment
    $requirements = Join-Path $script:RepoRoot "requirements.txt"
    $requirementsHash = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash
    $stamp = Join-Path $script:RuntimeRoot "requirements.sha256"
    $installedHash = if (Test-Path -LiteralPath $stamp) {
        (Get-Content -LiteralPath $stamp -Encoding ASCII -TotalCount 1).Trim()
    } else { "" }

    Invoke-AppPython -c "import flask, duckdb, numpy, pandas, plotly" *> $null
    $modulesReady = $LASTEXITCODE -eq 0
    if ($modulesReady -and $installedHash -eq $requirementsHash) { return }

    Write-Info "依赖首次安装或 requirements.txt 已变化，正在同步 Python 依赖。"
    Invoke-AppPython -m pip install -r $requirements
    if ($LASTEXITCODE -ne 0) { throw "Python 依赖安装失败。" }
    New-Item -ItemType Directory -Path $script:RuntimeRoot -Force | Out-Null
    Set-Content -LiteralPath $stamp -Value $requirementsHash -Encoding ASCII
}

function Test-ExpectedServer {
    try {
        $response = Invoke-WebRequest -Uri $script:Url -UseBasicParsing -TimeoutSec 2
    } catch {
        return $false
    }
    if ($response.StatusCode -eq 200 -and $response.Content -match [regex]::Escape($script:Version)) {
        Start-Process $script:Url
        return $true
    }
    throw "端口 $script:Port 已被其他程序或旧版本占用。请关闭对应窗口后重试。"
}

function Start-Analyzer {
    param([switch]$CheckOnly)
    $launcher = Join-Path $script:RepoRoot "wireless_trace_viewer.py"
    if (-not (Test-Path -LiteralPath $launcher)) { throw "缺少启动文件：$launcher" }
    Ensure-Dependencies
    if ($CheckOnly) {
        Write-Host "START_CHECK_OK version=$script:Version python=$script:VenvPython"
        return
    }
    if (Test-ExpectedServer) { return }
    Write-Info "启动 $script:Version，地址 $script:Url"
    Push-Location $script:RepoRoot
    try {
        Invoke-AppPython $launcher
        if ($LASTEXITCODE -ne 0) { throw "应用异常退出，代码 $LASTEXITCODE。" }
    } finally {
        Pop-Location
    }
}



