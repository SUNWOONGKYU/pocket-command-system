// 파견 분대장 산출물 스캔 + 대응이력 기록 — 순수 로직 분리 모듈.
//   agent-runner.ts 본체(하트비트·폴링·control=stop·기동·어댑터 dispatch)에서 이 세 함수만 떼어내
//   node --test 로 회귀 테스트가 가능하게 한다(CV Round3 Low-1 — 감사이력상 실결함이 가장 자주 났던
//   자리인데 테스트가 0이었다). agent-runner.ts 는 이 모듈을 import 해서 기존과 동일하게 호출한다.
//   단, recordDispatchResponse 의 중복 가드는 이 분리 과정에서 정규식 이스케이프를 함께 보강했다
//   (CV Round4 Low-1 — commit 값에 메타문자가 들어올 경우의 과매치를 선제 방어. 지금은 commit이
//   항상 't-'+16진수 형식이라 발생하지 않지만, RESPMETA 포맷이 나중에 바뀌면 조용한 대응 누락으로
//   이어질 수 있어 미리 막아 뒀다 — 아래 recordDispatchResponse 본문 참고). 그 외 함수는 정의
//   위치만 이동했을 뿐 동작 변경이 없다.
import * as fs from 'node:fs';
import * as path from 'node:path';

// 순회에서 건너뛸 디렉터리 — 빌드·의존성 산물은 산출물 힌트로서 가치가 없고 항목 수가 많다.
//   (감사 af40516f ⓐ: 제외 목록이 숨김·_audit·_작업이력.md 뿐이라 node_modules 같은 대용량 폴더를
//    그대로 완주했다. 워커는 단일 이벤트 루프라 그 동안 하트비트(5초 주기·30초 offline 임계)와
//    stop 폴링(1.5초)이 함께 멈춰 offline 오판·중단 지연으로 이어진다.)
export const SCAN_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', 'coverage', '.next',
]);
// 숨김 항목은 원칙적으로 제외하되(.git·.venv·샌드박스 부산물 등 잡음), '진짜 산출물일 수 있는' 몇 개는
//   예외로 본다(PO 결정 2026-07-26). 전엔 점으로 시작하면 전부 빠져서 .github/workflows 같은 정상
//   산출물이 힌트에서 사라졌다 — 감사관이 '변경 없음'으로 읽을 위험(검토 지적 ⑤).
//   node_modules 잡음 차단은 그대로 유지되므로 20건 상한을 다시 먹는 부작용은 없다.
export const SCAN_HIDDEN_ALLOW = new Set(['.github', '.well-known', '.openai', '.vscode', '.claude', '.config']);
// 방문 엔트리 예산 — 매칭이 20건에 못 미쳐도 이만큼 훑으면 중단한다. 제외 목록에 없는 대용량
// 폴더가 새로 생겨도 순회 시간이 상한을 넘지 않게 하는 안전판(위 ⓐ 권고의 '방문 예산').
export const SCAN_VISIT_BUDGET = 5000;

// 스캔 루트 정규화 — 같은 폴더가 두 번 들어오거나 한쪽이 다른 쪽 하위면 같은 파일을 중복 집계하고
//   출력 상한·방문 예산을 이중으로 태운다(검토 지적 ③). realpath 로 실경로를 맞춘 뒤 중복·중첩을 뺀다.
export function normalizeScanRoots(dirs: string[]): string[] {
  const real: string[] = [];
  for (const d of dirs) {
    let p: string;
    try { p = fs.realpathSync(path.resolve(d)); } catch { continue; } // 없는 폴더는 제외
    try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
    if (!real.includes(p)) real.push(p);
  }
  const under = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  return real.filter((d) => !real.some((o) => o !== d && under(d, o)));
}

// 이번 태스크 실행 중 변경된 산출물 후보(mtime 기준) — 감사관에게 검토 대상 힌트로 전달.
//   scanDirs: 실제로 훑을 폴더들(파견은 <root>/<kind>-worktree·<kind>-artifacts 둘 다).
//   relBase : 반환 경로의 기준(감사 프롬프트가 안내하는 폴더와 같아야 감사관이 파일을 찾을 수 있다).
// best-effort — 실패는 조용히 건너뛴다.
// 반환 경로는 relBase 기준 상대경로. 예산은 루트마다 따로 준다 — 한 루트가 크다고 뒤 루트가
//   통째로 안 읽히면(검토 지적 ③) 정작 봐야 할 산출물을 놓친다.
// 반환: { files, truncated } — truncated 는 상한/예산에 걸려 목록이 잘렸는지. 감사관에게 그대로 알린다
//   (검토 지적 ⑤: 잘린 사실이 콘솔에만 남으면 감사관은 '변경 없음'으로 오해한다).
export function recentOutputFiles(scanDirs: string[], relBase: string, sinceMs: number): { files: string[]; truncated: boolean } {
  const seen = new Set<string>();
  const out: string[] = [];
  let truncated = false;
  for (const root of normalizeScanRoots(scanDirs)) {
    let visited = 0;
    const walk = (dir: string, depth: number) => {
      if (out.length >= 20 || visited >= SCAN_VISIT_BUDGET) { truncated = true; return; }
      if (depth > 3) { truncated = true; return; }
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= 20 || visited >= SCAN_VISIT_BUDGET) { truncated = true; return; }
        visited++;
        if (e.name === '_audit' || e.name === '_작업이력.md') continue;
        // 숨김은 허용목록에 있는 폴더만 통과. 숨김 '파일'(.env 등)은 계속 제외 — 시크릿 위험 + 잡음.
        if (e.name.startsWith('.') && !(e.isDirectory() && SCAN_HIDDEN_ALLOW.has(e.name))) continue;
        if (e.isDirectory() && SCAN_SKIP_DIRS.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else {
          try {
            if (fs.statSync(p).mtimeMs < sinceMs) continue;
            const rel = path.relative(relBase, p).replace(/\\/g, '/');
            if (!seen.has(rel)) { seen.add(rel); out.push(rel); }
          } catch { /* 파일 소멸 등 — 무시 */ }
        }
      }
    };
    walk(root, 0);
  }
  return { files: out, truncated };
}

// 파견 분대장의 감사 대응을 러너가 대신 대응이력.md에 기록한다.
// 샌드박스 워커는 자기 작업폴더 밖(프로젝트 _audit)에 쓰지 못하고, 커맨드 텍스트로 쓰기 승인을 주는
// 길은 parseMercScope의 인용-주입 방어('[감사 대응]' 접두어면 토큰 무시, 감사 de1c229a)에 막혀 있다.
// 그 방어를 약화시키는 대신 결정론적 코드가 대신 쓴다 — CLI에 새 권한이 열리지 않는 유일한 경로다.
// 좌표는 respPrompt 말미의 [[RESPMETA ...]] 마커에서 읽는다(권한이 아니라 데이터).
// expectedAuditDir 는 러너가 스스로 계산한 대응이력 폴더다 — 마커 값은 이것과 일치할 때만 쓴다(아래 참고).
// selfName: 호출부(agent-runner.ts)의 워커 이름(NAME) — 로그·기본 대응자 표기에 쓴다. 순수 함수로
//   만들기 위해 모듈 전역을 참조하지 않고 인자로 받는다(동작은 기존과 동일, 호출부가 NAME을 넘긴다).
export function recordDispatchResponse(cmdText: string, output: string, expectedAuditDir: string, selfName: string): void {
  // 감사 의견 전문이 프롬프트에 인용되므로 의견 안에 이 마커가 '언급'돼 있을 수 있다(t-5c4b5515 실측:
  // 감사관이 '[[RESPMETA …]]'라고 축약 인용 → 첫 매치가 빈 값이라 조용히 기록이 누락됐다).
  // 러너가 붙이는 진짜 마커는 항상 맨 끝이므로 마지막 매치를 쓴다.
  const m = [...cmdText.matchAll(/\[\[RESPMETA ([^\]]+)\]\]/g)].pop();
  if (!m) return;
  const meta: Record<string, string> = {};
  for (const kv of m[1].split('|')) { const i = kv.indexOf('='); if (i > 0) meta[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
  const { auditDir, commit, worker } = meta;
  // typeof 검사를 먼저 — undefined 를 정규식에 넣으면 문자열 'undefined'로 강제변환돼 통과해버린다.
  if (typeof auditDir !== 'string' || typeof commit !== 'string' || !/^[\w.-]+$/.test(commit)) return;
  // 파견 산출물 감사(식별자 t- 접두)에서만 대행 기록한다(감사 c7af735d 권고 ⓑ).
  //   커밋 감사 대응 프롬프트에는 러너가 붙이는 진짜 마커가 아예 없다(respMeta 빈 문자열). 그때 감사
  //   의견 본문에 완전형 마커가 인용돼 있으면 그것이 유일·마지막 매치가 되어 진짜 좌표로 오인된다.
  if (!commit.startsWith('t-')) return;
  // 좌표를 값 그대로 신뢰하지 않는다(감사 c7af735d 권고 ⓐ). 러너가 스스로 계산한 경로와 일치할 때만
  //   쓴다 — 마커가 오염돼 임의 절대경로를 지목해도 러너(샌드박스 밖 node)가 거기에 쓰지 않는다.
  //   enqueueDispatchAudit 이 auditDir 을 <dispatchRoot>/_audit 로 만들므로 호출부가 같은 값을 넘긴다.
  if (path.resolve(auditDir) !== path.resolve(expectedAuditDir)) {
    console.error(`[${selfName}] 대응이력 기록 거부 — 마커 좌표(${auditDir})가 러너 계산 경로(${expectedAuditDir})와 불일치`);
    return;
  }
  const file = path.join(auditDir, '대응이력.md');
  try {
    // 중복 가드 — 같은 식별자의 대응 헤더가 이미 있으면 다시 쓰지 않는다(감사→대응 재적재 가드와 동일 규약).
    // commit은 위에서 /^[\w.-]+$/로만 걸러 '.'(정규식 메타문자, 임의 한 글자)이 그대로 허용된다 —
    //   지금은 항상 't-'+8자리 16진수라 실질 위험은 없지만, RegExp에 넣기 전에 이스케이프해 두면
    //   RESPMETA 포맷이 나중에 바뀌어도 이 가드가 조용히 과매치(=거짓 '이미 응답함'으로 정당한 대응
    //   기록을 누락)하는 사고를 원천 차단한다.
    const commitRe = commit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (fs.existsSync(file) && new RegExp('^## 커밋 ' + commitRe + ' 대응', 'm').test(fs.readFileSync(file, 'utf8'))) return;
    fs.mkdirSync(auditDir, { recursive: true });
    const ts = new Date().toLocaleString('sv-SE').slice(0, 16); // 로컬 'YYYY-MM-DD HH:MM'
    const who = worker || selfName || '';
    fs.appendFileSync(file, `\n## 커밋 ${commit} 대응 — ${ts} (${who}) [actor:daemon:${who}]\n${output.trim()}\n`);
    console.log(`[${selfName}] 대응이력 기록(러너 대행) — ${commit}`);
  } catch (e) { console.error(`[${selfName}] 대응이력 기록 실패(본류 무영향, 무시)`, e); }
}
