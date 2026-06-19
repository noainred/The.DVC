<#
  Remove the VMware Portal / Collector scheduled task. Run elevated.
      .\uninstall-service.ps1 [-TaskName "VMwarePortalCollector"]
#>
param([string]$TaskName = "VMwarePortalCollector")

schtasks /Query /TN $TaskName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  schtasks /End /TN $TaskName 2>$null | Out-Null
  schtasks /Delete /TN $TaskName /F | Out-Null
  Write-Host "제거 완료: $TaskName"
} else {
  Write-Host "작업이 없습니다: $TaskName"
}
