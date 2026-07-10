// 워커 커밋 → 감사 작업 큐 적재. 각 repo의 .git/hooks/post-commit 에서 호출.
//   사용:  node enqueue-audit.js <projectKey>     (실행 cwd = 커밋된 repo)
// 감사 의견·대응 이력은 repo 안 _감사\ 폴더(.gitignore)에 저장 → 커밋 안 됨 → post-commit 재귀 없음.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// .env.local은 이 스크립트 기준 상대경로로 — 머신마다 pocket-commander 클론 경로가 달라도(이 PC=C:\Dev\..., 랩탑=C:\...) 동작.
// (예전 하드코딩 'C:/Dev/pocket-commander/.env.local'은 랩탑에서 경로 불일치로 supabase 자격을 못 읽어 감사 스킵되던 버그.)
const ENV_PATH = path.join(__dirname, '..', '.env.local');

// 프로젝트별 설정: worker(작업 워커)·auditor(감사관)·criteria(5기준 텍스트)
const PROJECTS = {
  DID_system: {
    worker: 'DID', auditor: 'DID 감사관', criteria:
`① 정확성(코드·문서 오류·버그)
② DID 불변식·가드레일 준수("시스템은 결정 안 함", 'Aide' 용어 안 씀, MVP=Value 단일엔진+시트 등)
③ 작업 범위 일탈(scope creep)
④ 보안·위험
⑤ DID 특허 준수 — 핵심 발명요소(3D 좌표계 20유형 · 문서=Co-writer/비문서=Active Processor 분기 · 4+서브엔진 병렬 · 계층별 의사결정 · L1→L2→L3→L1 순환/자가개선)와 청구항 부합 여부. 필요시 Patent_DID\\ 명세서·청구항 대조.` },
  SAAH: {
    worker: '알파', auditor: '알파 감사관', criteria:
`① 정확성(코드 버그·오류)
② SAL Grid 기록 의무 — 코드 수정 시 grid_records/TASK_PLAN 반영 여부(SAL_Grid_Dev_Suite 규약). 미반영이면 '미완료'로 지적.
③ UI 실동작·dead-link — "curl 200 ≠ 동작". href 없는 버튼·클릭되는 <div>·존재하지 않는 라우트(404)·잘못된 경로/파라미터를 버그로 지적.
④ 작업 범위 일탈(scope creep)
⑤ 보안 — 시크릿·API 키 하드코딩, Supabase RLS 누락, 키 노출.` },
  ValueLink: {
    worker: 'ValueLink Developer', auditor: 'ValueLink Developer 감사관', criteria:
`① 정확성(코드 버그·로직 오류)
② 기존 기능 회귀 — 이번 변경이 기존 동작을 깨지 않는지, 테스트/검증이 동반됐는지.
③ 작업 범위 일탈(scope creep)
④ 보안 — 시크릿·키 노출, 입력 검증.
⑤ 코드 품질·유지보수성 — 중복·과복잡·네이밍·죽은 코드.` },
  'trader-bot': {
    worker: '주식 트레이더', auditor: '주식 트레이더 감사관', criteria:
`① 정확성(코드 버그·계산 오류)
② ★실거래 안전(최우선) — 오주문·체결 로직 결함·의도치 않은 매매·수량/가격 단위 오류·중복 주문 가능성을 최우선 점검.
③ 리스크 관리 — 손절·포지션 한도·예외처리·API 실패 시 안전정지(fail-safe) 여부.
④ 작업 범위 일탈(scope creep)
⑤ 보안 — API 키·계좌·시크릿 노출, 주문 권한 범위.` },
  WAAT: {
    worker: '찰리', auditor: '찰리 감사관', criteria:
`① 정확성(코드 버그·오류)
② UI 실동작·dead-link — "curl 200 ≠ 동작". href 없는 버튼·클릭되는 <div>·404·잘못된 경로/파라미터를 버그로 지적(모임·게시판 사이트라 사용자 여정 중요).
③ 작업 범위 일탈(scope creep)
④ 보안 — Supabase RLS·Auth(이메일/Google OAuth)·.env/Resend API 키 노출, 게시판 입력 XSS 검증.
⑤ 데이터·이메일 안전 — Resend 이메일 오발송(잘못된 수신자·스팸)·개인정보(이메일) 처리 적정성.` },
  'stock-prediction': {
    worker: '델타', auditor: '델타 감사관', criteria:
`① 정확성(코드·계산 오류·데이터 파이프라인 FDR/pykrx/DART)
② 데이터·알고리즘 정합성 — ★가짜/하드코딩 데이터 금지(placeholder 미매칭 시 DataMissingError 가드 준수)·미발동 토론/차트는 정직 표시·Chronos-2/Monte Carlo/rNPV 계산 타당성.
③ ★면책·규제 준수 — 추천(BUY/SELL) 금지 → 전망 성향(낙관/중립/회의)·확률·정보제공 면책 유지(유사투자자문 회피).
④ 작업 범위 일탈(scope creep)
⑤ 보안 — DART·API 키·시크릿 노출.` },
  'pocket-commander': {
    worker: '에코', auditor: '에코 감사관', criteria:
`① ★본체 무결성(최우선) — 워커 데몬(agent-runner)·오케스트레이터·모니터·하트비트/큐 폴링 루프를 깨뜨리지 않는가. 여기 결함은 전 워커 장애로 직결. 기동·세션 이어붙이기·중단(control=stop) 신호 회귀 점검.
② 시크릿 안전 — .env.local·API 키·토큰·service_role 노출, 로그/커밋에 시크릿 유입.
③ 재귀·안전 가드 훼손 — _audit/·sessions/ gitignore, CLAUDE_WIKI_CHILD, 감사 무한루프 방지 가드를 건드리지 않았는가.
④ 작업 범위 일탈(scope creep).
⑤ 정확성(코드 버그·로직 오류) + 공개본 분리 — 운영 PII/시크릿이 공개 repo(pocket-command-system)로 새지 않게.` },
};

function envGet(k) { try { const t = fs.readFileSync(ENV_PATH, 'utf8'); const m = t.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; } catch { return null; } }
function git(a) { try { return execSync('git ' + a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (e) { return ((e.stdout || '') + ''); } }

(async () => {
  const projectKey = process.argv[2];
  const cfg = PROJECTS[projectKey];
  if (!cfg) { console.error('[audit] 알 수 없는 프로젝트키:', projectKey, '— 스킵'); process.exit(0); }

  // ★ 워커 worktree 격리(PCS_WORKTREE) 도입 후: 커밋이 worktree cwd에서 만들어지면 process.cwd()가
  //   메인이 아닌 worktree 경로가 되어 auditDir이 워크트리별로 파편화된다(감사 이력이 메인 _audit과 따로 놈).
  //   `git rev-parse --git-common-dir`는 메인에서 실행하면 '.git'(상대), worktree에서 실행하면 항상
  //   메인 워크트리의 절대경로 '.git'을 반환한다 — 그 부모가 어느 cwd에서든 항상 메인 워크트리 루트다.
  //   (실측 확인: 임시 repo에서 메인='.git', worktree=절대경로 '<메인루트>/.git' 반환.)
  const commonDir = git('rev-parse --git-common-dir').trim();
  const repo = commonDir ? path.resolve(commonDir, '..') : process.cwd(); // 조회 실패 시 기존 동작(cwd)으로 폴백
  // 폴더명은 ASCII '_audit' — PowerShell 5.1이 한글 경로를 오독하는 문제 회피. (로그 파일명은 한글 유지)
  const auditDir = path.join(repo, '_audit').replace(/\\/g, '/');

  const url = envGet('NEXT_PUBLIC_SUPABASE_URL') || envGet('SUPABASE_URL');
  const key = envGet('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) { console.error('[audit] supabase 자격 없음 — 스킵'); process.exit(0); }

  const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' };

  const hash = git('log -1 --format=%H').trim();
  const short = hash.slice(0, 8);
  const author = git('log -1 --format=%an').trim();
  const subject = git('log -1 --format=%s').trim();
  const bodyRaw = git('log -1 --format=%b').trim();
  if (/\[no-audit\]/i.test(subject + ' ' + bodyRaw)) { console.log('[audit] [no-audit] 스킵'); process.exit(0); }
  // 비기능 커밋(docs/chore/style/ci)은 감사 자동 스킵 — 런타임 동작 무변경 → 감사 부하·claude 실행 횟수 절감.
  //   강제로 감사받으려면 커밋 메시지에 [audit] 태그를 넣는다.
  const TRIVIAL = /^(docs|chore|style|ci)\s*[(:]/i;
  // 단, 의존성 변경((deps)/(deps-dev) 스코프)은 보안 영향 가능 → 자동 스킵 예외(항상 감사).
  //   감사관 권고(커밋 9de58c4e 감사) 반영: 수동 [audit] 태그(기억 의존) 대신 코드로 구조적 보장.
  const DEPS = /^\w+\s*\(\s*deps(-dev)?\s*\)/i;
  if (TRIVIAL.test(subject) && !DEPS.test(subject) && !/\[audit\]/i.test(subject + ' ' + bodyRaw)) {
    console.log('[audit] 비기능 커밋(' + subject.split(/[\s(:]/)[0] + ') 자동 스킵 — 감사 생략');
    process.exit(0);
  }

  // ── 담당 host 게이트 (로컬 스킵 뒤 배치 — 스킵될 커밋엔 조회 왕복 없음) ──────────
  // 감사관은 자기 등록 host(= paired 워커가 실제 도는 세션 PC)에서 만들어진 커밋만 감사한다.
  //   같은 repo가 여러 PC에 클론되거나 G:드라이브로 동기화돼 있어도, 이 커밋이 만들어진 이 PC가
  //   감사관의 등록 host 목록에 없으면 적재하지 않는다 → '다른 세션의 커밋' 교차 감사를 코드로 차단.
  //   host 목록 전체와 대조(감사관명이 복수 host에 등록돼도 오탐 없음). 미등록/조회 실패면 기존대로 적재(폴백).
  try {
    const rh = await fetch(url + '/rest/v1/agents?select=host&name=eq.' + encodeURIComponent(cfg.auditor), { headers: H });
    const jh = await rh.json();
    const hosts = Array.isArray(jh) ? jh.map((x) => x.host).filter(Boolean) : [];
    const here = os.hostname();
    if (hosts.length && !hosts.map((h) => String(h).toLowerCase()).includes(here.toLowerCase())) {
      console.log('[audit] host 불일치(' + here + ' not-in [' + hosts.join(',') + ']) — 다른 세션/PC 커밋, 적재 스킵:', projectKey);
      process.exit(0);
    }
  } catch (e) { /* 조회 실패 시 기존 동작 유지(적재) */ }

  const stat = git('show --stat --format= ' + hash).trim();
  let diff = git('show --format= ' + hash);
  let truncated = false; const MAX = 40000;
  if (diff.length > MAX) { diff = diff.slice(0, MAX); truncated = true; }

  let chatId = null;
  try { const r = await fetch(url + '/rest/v1/tasks?source_chat_id=not.is.null&select=source_chat_id&order=created_at.desc&limit=1', { headers: H }); const j = await r.json(); chatId = (j && j[0]) ? j[0].source_chat_id : null; } catch { }

  // 이 커밋이 실제로 워커 데몬(agent-runner) 자신의 작업 실행 중에 만들어졌는지 판별.
  //   워커 데몬은 claude 하위 프로세스에 PCS_ACTOR=<워커명>을 심어 실행한다(agent-runner.ts).
  //   대화형 Claude Code 세션(사람이 직접 붙어 작업)은 이 환경변수가 없으므로 actor가 다르게 찍힌다.
  //   → 감사 자체는 항상 하되(누가 커밋했든 품질 게이트는 필요), '감사 대응'을 엉뚱한 유휴 워커에게
  //     떠넘기지 않기 위해 이 표식을 감사 완료 후 대응 라우팅 판단에 쓴다(agent-runner.ts 참고).
  const actor = process.env.PCS_ACTOR === cfg.worker ? 'daemon' : 'interactive';

  const prompt =
`[커밋 감사 — 소스 읽기전용] ${projectKey} 저장소에 새 커밋이 생겼다(${actor === 'daemon' ? `워커 '${cfg.worker}'가 자기 작업 중 생성` : '대화형 Claude Code 세션에서 생성 — 워커 자동 작업 아님'}).
커밋: ${hash}
작성자: ${author}
메시지: ${subject}${bodyRaw ? ('\n' + bodyRaw) : ''}

[변경 요약]
${stat}

[변경 내용${truncated ? ' (앞부분만)' : ''}]
${diff}

너는 '${cfg.auditor}'이다. 위 커밋을 감사하라. 5기준:
${cfg.criteria}

규칙:
- 저장소 소스 파일은 절대 수정·커밋하지 마라. 읽기·검토만(맥락 필요시 git show·파일 읽기).
- 단, '${auditDir}' 폴더에는 쓰기 허용. 감사 의견을 '${auditDir}/감사이력.md' 에 append 하라.
- 헤더 형식(둘 중 하나, 그대로 사용): ${actor === 'daemon'
  ? `'## 커밋 ${short} 감사 — <시각> (${cfg.auditor})' — 워커 '${cfg.worker}'의 정상 자동 작업 커밋.`
  : `'## 커밋 ${short} 감사 — <시각> (${cfg.auditor}) [대화형 세션 전달 필요]' — 대화형 Claude Code 세션이 만든 커밋이라, 워커 '${cfg.worker}'가 아니라 그 대화형 세션이 확인·응답해야 함을 헤더에 명시하라. 대응 작업은 워커에게 자동 배정되지 않는다.`}
- 감사 의견은 한국어로 간결하게: 첫 줄에 판정 [정상]/[경미]/[주의]/[중대], 이어서 기준별 근거·권고.
[[AUDITMETA project=${projectKey}|worker=${cfg.worker}|auditDir=${auditDir}|commit=${short}|host=${os.hostname()}|actor=${actor}]]`;

  try {
    const r = await fetch(url + '/rest/v1/tasks', { method: 'POST', headers: H, body: JSON.stringify({ command_text: prompt, assigned_agent: cfg.auditor, status: 'queued', source_chat_id: chatId }) });
    if (r.ok) console.log('[audit] 적재:', projectKey, short, '→', cfg.auditor, '| chat:', chatId ?? '-');
    else console.error('[audit] 적재 실패', r.status, await r.text());
  } catch (e) { console.error('[audit] 네트워크 오류', String(e)); }
})();
