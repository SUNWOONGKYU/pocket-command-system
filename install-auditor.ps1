# 프로젝트 repo에 감사관 파이프라인 설치 (PC·repo당 1회).
#   사용:  .\install-auditor.ps1 -Project project-a -RepoPath C:\Dev\project-a
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
#    워커 worktree 격리(PCSS_WORKTREE) 대비 MAIN_ROOT를 git-common-dir 기준 절대경로로 고정하고
#    (cwd가 워크트리든 메인이든 항상 메인 워크트리의 _audit/로 로그가 모인다),
#    node 실행 전 mkdir -p로 _audit/를 보장한다 — 폴더가 없으면 리다이렉트(>>) 자체가 실패해
#    node가 아예 실행되지 않고 감사 요청이 통째로 누락되는 침묵 실패를 방지(2026-07-24 e2e 실증 발견).
$hook = Join-Path $repo '.git/hooks/post-commit'
$hookBody = "#!/bin/sh`n" +
            "# auditor trigger - enqueue audit task after commit (auditor is auto-only)`n" +
            "MAIN_ROOT=`$(dirname `"`$(git rev-parse --git-common-dir)`")`n" +
            "mkdir -p `"`$MAIN_ROOT/_audit`"`n" +
            "node `"$pcm/scripts/enqueue-audit.js`" $Project >> `"`$MAIN_ROOT/_audit/hook.log`" 2>&1`n" +
            "exit 0`n"
[System.IO.File]::WriteAllText($hook, $hookBody, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "감사관 파이프라인 설치 완료"
Write-Host " - project : $Project"
Write-Host " - repo    : $repo"
Write-Host " - folder  : $auditDir  (.gitignore)"
Write-Host " - hook    : $hook  ->  enqueue-audit.js $Project"
Write-Host "다음: 이 PC에서 update.bat (또는 start-workers.ps1) 실행 -> 감사관 워커 자동 기동 (DB host 등록 전제)."
