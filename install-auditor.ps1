# 프로젝트 repo에 감사관 파이프라인 설치 (PC·repo당 1회).
#   사용:  .\install-auditor.ps1 -Project DID_system -RepoPath C:\Dev\DID_system
# 하는 일: (1) repo 안 _audit\ 폴더 생성 (2) .gitignore 에 _audit/ 등록(커밋 금지=재귀 방지)
#          (3) .git/hooks/post-commit 설치 -> 커밋 시 enqueue-audit.js <Project> 호출
# 폴더명은 ASCII '_audit' (PowerShell 5.1 한글 경로 오독 회피). 로그 파일(감사이력.md 등)은 claude가 한글로 작성.
# 감사관 워커는 DB에 host=이 PC로 등록돼 있어야 하며 update.bat/start-workers.ps1 로 기동된다.
param(
  [Parameter(Mandatory = $true)][string]$Project,
  [string]$RepoPath = (Get-Location).Path
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$pcm = ($PSScriptRoot -replace '\\', '/')
$repo = (Resolve-Path $RepoPath).Path
if (-not (Test-Path (Join-Path $repo '.git'))) { throw "git repo가 아닙니다: $repo" }

# 1) _audit 폴더
$auditDir = Join-Path $repo '_audit'
New-Item -ItemType Directory -Force -Path $auditDir | Out-Null

# 2) .gitignore 에 _audit/ 등록
$gi = Join-Path $repo '.gitignore'
$line = '_audit/'
$has = (Test-Path $gi) -and ((Get-Content $gi -ErrorAction SilentlyContinue) | Where-Object { $_.Trim() -eq $line })
if (-not $has) {
  Add-Content -Path $gi -Value "`n# audit trail (do not commit - prevents post-commit recursion)`n$line" -Encoding UTF8
  Write-Host " .gitignore 에 _audit/ 추가"
}

# 3) post-commit 훅 (sh, BOM 없는 UTF-8, LF)
$hook = Join-Path $repo '.git/hooks/post-commit'
$hookBody = "#!/bin/sh`n" +
            "# auditor trigger - enqueue audit task after commit (auditor is auto-only)`n" +
            "node `"$pcm/scripts/enqueue-audit.js`" $Project >> `"_audit/hook.log`" 2>&1`n" +
            "exit 0`n"
[System.IO.File]::WriteAllText($hook, $hookBody, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "감사관 파이프라인 설치 완료"
Write-Host " - project : $Project"
Write-Host " - repo    : $repo"
Write-Host " - folder  : $auditDir  (.gitignore)"
Write-Host " - hook    : $hook  ->  enqueue-audit.js $Project"
Write-Host "다음: 이 PC에서 update.bat (또는 start-workers.ps1) 실행 -> 감사관 워커 자동 기동 (DB host 등록 전제)."
