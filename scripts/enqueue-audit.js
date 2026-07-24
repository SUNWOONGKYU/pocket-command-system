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

// 프로젝트별 설정(worker·auditor·criteria)은 공개본에 실데이터가 tracked되지 않도록 JSON으로 외부화했다.
//   config/audit-projects.local.json(운영 실데이터, gitignore) 있으면 그걸, 없으면
//   config/audit-projects.json(공개본에 tracked된 일반화 예시)을 __dirname 기준으로 읽는다.
//   ★ 워커 감사 파이프라인 핵심 — 운영에선 local.json에서 실데이터를 읽어 기존과 100% 동일하게 동작해야 한다.
const PROJECTS_LOCAL_PATH = path.join(__dirname, '..', 'config', 'audit-projects.local.json');
const PROJECTS_EXAMPLE_PATH = path.join(__dirname, '..', 'config', 'audit-projects.json');
function loadProjects() {
  try {
    const p = fs.existsSync(PROJECTS_LOCAL_PATH) ? PROJECTS_LOCAL_PATH : PROJECTS_EXAMPLE_PATH;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[audit] 프로젝트 설정 로드 실패 — 스킵', e);
    return {};
  }
}
const PROJECTS = loadProjects();

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
  //   워커 데몬은 claude 하위 프로세스에 PCSS_ACTOR=<워커명>(legacy PCS_ACTOR도 임시 병행)을 심어 실행한다(agent-runner.ts).
  //   대화형 Claude Code 세션(사람이 직접 붙어 작업)은 이 환경변수가 없으므로 actor가 다르게 찍힌다.
  //   → 감사 자체는 항상 하되(누가 커밋했든 품질 게이트는 필요), '감사 대응'을 엉뚱한 유휴 워커에게
  //     떠넘기지 않기 위해 이 표식을 감사 완료 후 대응 라우팅 판단에 쓴다(agent-runner.ts 참고).
  const actor = (process.env.PCSS_ACTOR || process.env.PCS_ACTOR) === cfg.worker ? 'daemon' : 'interactive';

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
