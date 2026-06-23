// 워커 커밋 → 감사 작업 큐 적재. 각 repo의 .git/hooks/post-commit 에서 호출.
//   사용:  node enqueue-audit.js <projectKey>     (실행 cwd = 커밋된 repo)
// 감사 의견·대응 이력은 repo 안 _감사\ 폴더(.gitignore)에 저장 → 커밋 안 됨 → post-commit 재귀 없음.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENV_PATH = 'C:/Dev/pocket-commander/.env.local';

// 프로젝트별 설정: worker(작업 워커)·auditor(감사관)·criteria(5기준 텍스트)
const PROJECTS = {
  DID_system: {
    worker: '브라보', auditor: '브라보 감사관', criteria:
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
};

function envGet(k) { try { const t = fs.readFileSync(ENV_PATH, 'utf8'); const m = t.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; } catch { return null; } }
function git(a) { try { return execSync('git ' + a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (e) { return ((e.stdout || '') + ''); } }

(async () => {
  const projectKey = process.argv[2];
  const cfg = PROJECTS[projectKey];
  if (!cfg) { console.error('[audit] 알 수 없는 프로젝트키:', projectKey, '— 스킵'); process.exit(0); }

  const repo = process.cwd();
  // 폴더명은 ASCII '_audit' — PowerShell 5.1이 한글 경로를 오독하는 문제 회피. (로그 파일명은 한글 유지)
  const auditDir = path.join(repo, '_audit').replace(/\\/g, '/');

  const url = envGet('NEXT_PUBLIC_SUPABASE_URL') || envGet('SUPABASE_URL');
  const key = envGet('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) { console.error('[audit] supabase 자격 없음 — 스킵'); process.exit(0); }

  const hash = git('log -1 --format=%H').trim();
  const short = hash.slice(0, 8);
  const author = git('log -1 --format=%an').trim();
  const subject = git('log -1 --format=%s').trim();
  const bodyRaw = git('log -1 --format=%b').trim();
  if (/\[no-audit\]/i.test(subject + ' ' + bodyRaw)) { console.log('[audit] [no-audit] 스킵'); process.exit(0); }

  const stat = git('show --stat --format= ' + hash).trim();
  let diff = git('show --format= ' + hash);
  let truncated = false; const MAX = 40000;
  if (diff.length > MAX) { diff = diff.slice(0, MAX); truncated = true; }

  const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  let chatId = null;
  try { const r = await fetch(url + '/rest/v1/tasks?source_chat_id=not.is.null&select=source_chat_id&order=created_at.desc&limit=1', { headers: H }); const j = await r.json(); chatId = (j && j[0]) ? j[0].source_chat_id : null; } catch { }

  const prompt =
`[커밋 감사 — 소스 읽기전용] ${cfg.worker}가 방금 ${projectKey} 저장소에 만든 커밋이다.
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
- 단, '${auditDir}' 폴더에는 쓰기 허용. 감사 의견을 '${auditDir}/감사이력.md' 에 append 하라(헤더에 커밋 ${short}·시각 포함).
- 감사 의견은 한국어로 간결하게: 첫 줄에 판정 [정상]/[경미]/[주의]/[중대], 이어서 기준별 근거·권고.
[[AUDITMETA project=${projectKey}|worker=${cfg.worker}|auditDir=${auditDir}|commit=${short}]]`;

  try {
    const r = await fetch(url + '/rest/v1/tasks', { method: 'POST', headers: H, body: JSON.stringify({ command_text: prompt, assigned_agent: cfg.auditor, status: 'queued', source_chat_id: chatId }) });
    if (r.ok) console.log('[audit] 적재:', projectKey, short, '→', cfg.auditor, '| chat:', chatId ?? '-');
    else console.error('[audit] 적재 실패', r.status, await r.text());
  } catch (e) { console.error('[audit] 네트워크 오류', String(e)); }
})();
