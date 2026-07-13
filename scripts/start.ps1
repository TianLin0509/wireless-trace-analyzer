param([switch]$Check)

. (Join-Path $PSScriptRoot "common.ps1")
Start-Analyzer -CheckOnly:$Check

