<#
  Install the VMware Portal / Collector as an auto-starting Windows background
  service using a Scheduled Task (no extra binaries required).

  The task runs start-portal.bat at system startup as SYSTEM, hidden, and
  restarts on failure. Run from an elevated (Administrator) PowerShell:

      .\install-service.ps1

  Optional: -TaskName "VMwarePortalCollector"
#>
param(
  [string]$TaskName = "VMwarePortalCollector"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$bat  = Join-Path $here "start-portal.bat"
if (-not (Test-Path $bat)) { throw "start-portal.bat 를 찾을 수 없습니다: $bat" }

Write-Host "==> Scheduled Task 등록: $TaskName"
Write-Host "    실행 파일: $bat"

# Remove any previous task
schtasks /Query /TN $TaskName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host "    기존 작업 제거..."
  schtasks /Delete /TN $TaskName /F | Out-Null
}

$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$bat`""
$trigger  = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "==> 즉시 시작..."
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "✅ 설치 완료. 부팅 시 자동 실행됩니다."
Write-Host "   상태:   schtasks /Query /TN $TaskName"
Write-Host "   중지:   schtasks /End  /TN $TaskName"
Write-Host "   제거:   .\uninstall-service.ps1"
Write-Host "   접속:   http://localhost:%PORT% (기본 4000)"
