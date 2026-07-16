# Pocket Commander — 이 PC 담당 워커 기동 (부팅/로그온 자동 실행용)
# update.ps1 과 달리 git pull/npm install 없이 빠르게: 기존 워커 정리 후 이 PC host 워커만 기동.
# 자동 실행 등록은 install-autostart.ps1 (PC당 1회) 참조.
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$me = [System.Net.Dns]::GetHostName()
Write-Host "=== Pocket Commander 워커 기동 ($me) $(Get-Date -Format 'yyyy-MM-dd HH:mm') ==="

# 중복 방지: 기존 agent-runner 프로세스 종료
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*agent-runner*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# 이 PC(host=$me) 담당 워커 목록 산출
& node "scripts/list-my-agents.js"
$listFile = Join-Path $PSScriptRoot "scripts/.my-agents.txt"
$logDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $listFile)) {
  Write-Host "목록 파일 없음 (.env.local·DB·네트워크 확인)."
  return
}
$names = @(Get-Content -Path $listFile -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
if ($names.Count -eq 0) { Write-Host "이 PC로 등록된 워커가 없습니다 (DB host 값 확인)."; return }

# 상위모델(Opus) 지정 워커 — 감사관은 agent-runner가 이름('감사관')으로 자동 Opus.
# 그 외 전략역할(예: 사업총괄)은 여기서 CLAUDE_MODEL 을 명시해 상위모델로 띄운다.
# 대상 이름은 운영 데이터라 추적 파일에 박지 않고 gitignored 로컬 목록에서 읽는다(공개본 분리).
#   scripts/opus-workers.local.txt — 한 줄에 워커 이름 하나(없으면 감사관만 Opus).
$opusListFile = Join-Path $PSScriptRoot "scripts/opus-workers.local.txt"
$opusWorkers = if (Test-Path $opusListFile) {
  @(Get-Content -Path $opusListFile -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
} else { @() }

foreach ($name in $names) {
  $safe = ($name -replace '\s', '_')
  $log = Join-Path $logDir ("worker_" + $safe + ".log")
  Write-Host "  -> $name"
  # 이름은 환경변수로 전달 — 공백 있는 이름이 argv에서 쪼개지는 버그 회피.
  $env:AGENT_NAME = $name
  # ★ 한시적(PO 지시 2026-07-16): 전 워커 Fable 5 통일 — opus 예외 목록을 잠시 무시한다.
  #   해제 시 아래 한 줄을 지우고 원래 조건부(opus-workers.local.txt 기반)를 복원하면 됨.
  #   if ($opusWorkers -contains $name) { $env:CLAUDE_MODEL = 'claude-opus-4-8' } else { $env:CLAUDE_MODEL = $null }
  $env:CLAUDE_MODEL = $null
  Start-Process -FilePath "node" `
    -ArgumentList "--import", "tsx", "worker/agent-runner.ts" `
    -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError ($log + ".err")
  Start-Sleep -Milliseconds 500
  $env:AGENT_NAME = $null
  $env:CLAUDE_MODEL = $null
}
Write-Host "완료. 워커 $($names.Count)개 기동: $($names -join ', ')"
