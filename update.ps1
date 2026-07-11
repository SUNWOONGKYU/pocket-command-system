# Pocket Commander — 워커 원클릭 업데이트 (이 PC에서 실행)
# git pull → 의존성 → 이 PC 담당 워커 자동 감지 → 재기동.
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$me = [System.Net.Dns]::GetHostName()
Write-Host "=== Pocket Commander 워커 업데이트 ($me) ==="

Write-Host "[1/4] git pull..."
git pull

Write-Host "[2/4] npm install..."
npm install --no-audit --no-fund 2>$null

Write-Host "[3/4] 기존 워커 종료..."
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*agent-runner*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

Write-Host "[4/4] 이 PC 담당 워커 재기동..."
& node "scripts/list-my-agents.js"
$listFile = Join-Path $PSScriptRoot "scripts/.my-agents.txt"
$logDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $listFile)) {
  Write-Host "  목록 파일이 없습니다(.env.local·DB 확인)."
} else {
  $names = @(Get-Content -Path $listFile -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  if ($names.Count -eq 0) {
    Write-Host "  이 PC(host=$me)로 등록된 워커가 없습니다. 중앙 DB의 host 값을 확인하세요."
  } else {
    foreach ($name in $names) {
      $safe = ($name -replace '\s', '_')
      $log = Join-Path $logDir ("worker_" + $safe + ".log")
      Write-Host "  -> $name"
      # 이름은 환경변수로 전달 — 공백 있는 이름("Worker Name" 등)이 argv에서 쪼개지는 버그 회피.
      # PowerShell의 $env 는 유니코드라 한글·공백 모두 안전하며, Start-Process가 부모 env를 상속한다.
      $env:AGENT_NAME = $name
      Start-Process -FilePath "node" `
        -ArgumentList "--import", "tsx", "worker/agent-runner.ts" `
        -WindowStyle Hidden `
        -RedirectStandardOutput $log `
        -RedirectStandardError ($log + ".err")
      Start-Sleep -Milliseconds 500
      $env:AGENT_NAME = $null
    }
  }
}

Start-Sleep -Seconds 3
Write-Host ""
Write-Host "완료. 대시보드: <배포한 대시보드 URL>"
Write-Host "워커가 모두 가동됩니다(창 닫아도 백그라운드 유지). 대시보드에서 초록불 확인하세요."
