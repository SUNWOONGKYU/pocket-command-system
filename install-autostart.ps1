# PCSS — OS 로그온 시 워커 자동 기동 등록 (이 PC에서 1회 실행)
# 로그온 1분 후 start-workers.ps1 을 실행하는 예약 작업을 만든다.
# (시작 시점=AtStartup 이 아니라 로그온=AtLogOn 인 이유: claude CLI 구독 인증이
#  사용자 프로필에 있어 SYSTEM 계정에선 동작하지 않기 때문.)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$script = Join-Path $root 'start-workers.ps1'
$taskName = 'PocketCommander-Workers'

if (-not (Test-Path $script)) { throw "start-workers.ps1 이 없습니다: $script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
try { $trigger.Delay = 'PT1M' } catch { }  # 네트워크 기동 대기

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "등록 완료: '$taskName' — 로그온 1분 후 start-workers.ps1 실행 (사용자: $env:USERNAME)"
Write-Host "수동 점검:  Start-ScheduledTask -TaskName '$taskName'  /  해제:  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
