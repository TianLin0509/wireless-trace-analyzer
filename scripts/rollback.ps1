param([switch]$Check, [switch]$Force)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
. (Join-Path $PSScriptRoot "offline-update-core.ps1")

$stateRoot = Join-Path $script:RuntimeRoot "offline-updates"
if ($Check) {
    $info = Get-OfflineRollbackInfo -StateRoot $stateRoot
    Write-Host "ROLLBACK_CHECK_OK from=$($info.record.to_version) to=$($info.record.from_version)"
    return
}

$result = Invoke-OfflineRollback `
    -TargetRoot $script:RepoRoot `
    -StateRoot $stateRoot `
    -NonInteractive:$Force

if (-not $result) { return }
$script:Version = $result.to_version
Start-Analyzer
