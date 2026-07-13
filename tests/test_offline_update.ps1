$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
$coreScript = Join-Path $repoRoot "scripts\offline-update-core.ps1"
if (-not (Test-Path -LiteralPath $coreScript)) {
    throw "Missing offline update core: $coreScript"
}
. $coreScript

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    if ($Actual -ne $Expected) {
        throw "$Message. expected=[$Expected] actual=[$Actual]"
    }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("wireless-trace-update-test-" + [guid]::NewGuid().ToString("N"))
$targetRoot = Join-Path $tempRoot "target"
$patchRoot = Join-Path $tempRoot "patch"
$payloadRoot = Join-Path $patchRoot "payload"
$stateRoot = Join-Path $tempRoot "state"

try {
    New-Item -ItemType Directory -Path (Join-Path $targetRoot "app") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $payloadRoot "app") -Force | Out-Null

    Set-Content -LiteralPath (Join-Path $targetRoot "VERSION") -Value "v1.0.0" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $targetRoot "app\changed.txt") -Value "old" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $targetRoot "app\deleted.txt") -Value "restore-me" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $targetRoot "app\untouched.txt") -Value "keep" -Encoding UTF8

    Set-Content -LiteralPath (Join-Path $payloadRoot "VERSION") -Value "v1.0.1" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $payloadRoot "app\changed.txt") -Value "new" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $payloadRoot "app\added.txt") -Value "added" -Encoding UTF8

    $files = @()
    foreach ($relativePath in @("app/changed.txt", "app/added.txt", "VERSION")) {
        $payloadPath = Join-Path $payloadRoot ($relativePath -replace "/", "\")
        $files += [ordered]@{
            path = $relativePath
            sha256 = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash
            size = (Get-Item -LiteralPath $payloadPath).Length
        }
    }
    $manifest = [ordered]@{
        schema_version = 1
        from_version = "v1.0.0"
        to_version = "v1.0.1"
        files = $files
        delete = @("app/deleted.txt")
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $patchRoot "update-manifest.json") -Encoding UTF8

    $applied = Invoke-OfflinePatch -PatchDirectory $patchRoot -TargetRoot $targetRoot -StateRoot $stateRoot -NonInteractive
    Assert-Equal $applied.from_version "v1.0.0" "Apply result from_version mismatch"
    Assert-Equal $applied.to_version "v1.0.1" "Apply result to_version mismatch"
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $targetRoot "VERSION") -Encoding UTF8 -TotalCount 1).Trim()) "v1.0.1" "Version was not updated"
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $targetRoot "app\changed.txt") -Encoding UTF8 -TotalCount 1).Trim()) "new" "Changed file was not updated"
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $targetRoot "app\added.txt") -Encoding UTF8 -TotalCount 1).Trim()) "added" "Added file is missing"
    Assert-Equal (Test-Path -LiteralPath (Join-Path $targetRoot "app\deleted.txt")) $false "Deleted file still exists"
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $targetRoot "app\untouched.txt") -Encoding UTF8 -TotalCount 1).Trim()) "keep" "Untouched file was modified"

    $rolledBack = Invoke-OfflineRollback -TargetRoot $targetRoot -StateRoot $stateRoot -NonInteractive
    Assert-Equal $rolledBack.to_version "v1.0.0" "Rollback target version mismatch"
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $targetRoot "VERSION") -Encoding UTF8 -TotalCount 1).Trim()) "v1.0.0" "Version was not rolled back"
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $targetRoot "app\changed.txt") -Encoding UTF8 -TotalCount 1).Trim()) "old" "Changed file was not restored"
    Assert-Equal (Test-Path -LiteralPath (Join-Path $targetRoot "app\added.txt")) $false "New file was not removed during rollback"
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $targetRoot "app\deleted.txt") -Encoding UTF8 -TotalCount 1).Trim()) "restore-me" "Deleted file was not restored"
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $targetRoot "app\untouched.txt") -Encoding UTF8 -TotalCount 1).Trim()) "keep" "Untouched file changed after rollback"

    $patchZip = Join-Path $tempRoot "patch.zip"
    Compress-Archive -Path (Join-Path $patchRoot "*") -DestinationPath $patchZip -CompressionLevel Optimal
    $appliedFromZip = Invoke-OfflinePatch -PatchZip $patchZip -TargetRoot $targetRoot -StateRoot $stateRoot -NonInteractive
    Assert-Equal $appliedFromZip.to_version "v1.0.1" "ZIP apply target version mismatch"
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $targetRoot "app\changed.txt") -Encoding UTF8 -TotalCount 1).Trim()) "new" "ZIP apply did not update changed file"
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $targetRoot "app\untouched.txt") -Encoding UTF8 -TotalCount 1).Trim()) "keep" "ZIP apply modified untouched file"
    [void](Invoke-OfflineRollback -TargetRoot $targetRoot -StateRoot $stateRoot -NonInteractive)

    Write-Host "OFFLINE_UPDATE_TEST_OK"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
