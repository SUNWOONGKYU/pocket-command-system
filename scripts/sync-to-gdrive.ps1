# 로컬 작업 저장소 → G드라이브 보관본 단방향 동기화 (PCSS 공용)
#
# 배경: 작업은 로컬(C:)에서 한다 — 구글 드라이브 동기화 폴더에서 git·빌드를 돌리면 동기화 충돌·
#   파일 잠금·대량 트래픽이 난다. 그래도 폰에서 문서를 바로 보려면 G드라이브에 사본이 있어야 한다.
#   그래서 "로컬이 원본, G드라이브는 읽기용 보관본" 구조로 두고 이 스크립트가 한 방향으로만 민다.
#
# ★비파괴: /MIR(미러)를 쓰지 않는다. 대상에만 있는 파일을 지우지 않는다.
#   폰이나 다른 PC에서 G드라이브에 뭔가를 올려놨더라도 이 동기화가 그걸 삭제하지 않는다.
#   (로컬에서 지운 파일을 G에서도 지우고 싶으면 -Mirror 를 명시해야 한다 — 파괴적이라 기본값 아님.)
#
# 제외: .git·의존성·빌드 산물·감사 폴더·파견 분대장 작업공간·세션 로그.
#   이것들은 폰에서 볼 이유가 없고, 특히 .git 과 node_modules 는 파일 수가 많아 동기화를 마비시킨다.
#
# 사용:
#   .\scripts\sync-to-gdrive.ps1 -Source "C:\Dev\여가플랫폼" -Dest "G:\내 드라이브\여가플랫폼"
#   .\scripts\sync-to-gdrive.ps1 -Source ... -Dest ... -Mirror      # 삭제까지 반영(파괴적)
#   .\scripts\sync-to-gdrive.ps1 -Source ... -Dest ... -WhatIf      # 무엇이 복사될지만 표시

param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Dest,
  [switch]$Mirror,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
# ★[Console]::OutputEncoding 을 UTF8 로 바꾸지 마라. robocopy 는 ANSI 시절 도구라 콘솔 인코딩을
#   UTF-8 로 강제하면 한글이 든 경로(예: C:\Dev\여가플랫폼)의 비교가 깨져 /XD·/XF 제외가 통째로
#   무시된다(실측 2026-07-27: 같은 인자를 UTF8 설정 없이 주면 정상 제외, 설정하면 .git·sessions·
#   _audit 까지 전부 복사 대상에 잡혔다). 콘솔에 한글이 깨져 보이는 건 감수한다 — 동작이 우선이다.

if (-not (Test-Path -LiteralPath $Source)) { Write-Error "원본 없음: $Source"; exit 1 }
if (-not (Test-Path -LiteralPath $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }

# 폴더 제외 — 폰에서 볼 이유가 없고 파일 수가 많아 동기화를 망가뜨리는 것들.
#   ★전체 경로가 아니라 '이름'으로 넘긴다. robocopy /XD 는 이름만 주면 어느 깊이에서든 매칭하고,
#   무엇보다 Source 경로에 한글이 들어가면(예: C:\Dev\여가플랫폼) 네이티브 exe 로 전달되며 인코딩이
#   깨져 제외가 통째로 무시된다(실측: .git·sessions 까지 복사 대상에 잡혔다). 이름은 전부 ASCII 다.
$excludeDirs = @(
  '.git', 'node_modules', '.next', 'dist', 'build', 'out', 'coverage',
  '_audit', '_audit_vault', '_agentwork', '_WorkLog', 'sessions',
  'codex-worktree', 'codex-artifacts',
  'grok-worktree', 'grok-artifacts',
  'antigravity-worktree', 'antigravity-artifacts'
)

# 파일 제외 — 시크릿과 OS 부산물은 클라우드로 올리지 않는다
$excludeFiles = @('.env', '.env.local', '.env.*.local', 'Thumbs.db', 'desktop.ini', '.DS_Store')

# ★변수명 주의: $args 는 PowerShell 예약 자동 변수다. 여기에 담으면 robocopy 로 제대로 전달되지
#   않아 /XD·/XF 제외가 통째로 무시된다(실측: .git·node_modules 까지 복사 대상에 잡혔다).
$rcArgs = @($Source, $Dest, '/E', '/FFT', '/R:2', '/W:2', '/NP', '/NDL', '/NJH')
if ($Mirror) { $rcArgs += '/PURGE' }        # 대상에만 있는 파일 삭제 — 명시적 요청일 때만
if ($WhatIf) { $rcArgs += '/L' }            # 목록만, 실제 복사 안 함
$rcArgs += '/XD'; $rcArgs += $excludeDirs
$rcArgs += '/XF'; $rcArgs += $excludeFiles

Write-Host "[sync] $Source  ->  $Dest" -ForegroundColor Cyan
if ($Mirror) { Write-Host "[sync] MIRROR 모드 — 원본에 없는 대상 파일은 삭제됩니다." -ForegroundColor Yellow }

& robocopy @rcArgs | Out-String | Write-Host

# robocopy 종료코드: 0~7 정상(8 이상이 실패). 0=변경없음, 1=복사됨, 2=추가파일, 3=1+2 ...
$rc = $LASTEXITCODE
if ($rc -ge 8) { Write-Error "[sync] 실패 (robocopy exit $rc)"; exit $rc }
Write-Host "[sync] 완료 (robocopy exit $rc — 8 미만은 정상)" -ForegroundColor Green
exit 0
