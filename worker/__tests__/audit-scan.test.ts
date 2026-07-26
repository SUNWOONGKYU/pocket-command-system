// worker/audit-scan.ts 회귀 테스트 — normalizeScanRoots/recentOutputFiles/recordDispatchResponse.
//   CV Round3 Low-1: 감사이력상 실결함이 가장 자주 났던 세 함수가 테스트 스코프 밖이었다.
//   node --test 가 .ts 를 그대로 실행하도록 tsx 로더를 쓴다 — package.json "test" 스크립트 참고.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { normalizeScanRoots, recentOutputFiles, recordDispatchResponse, SCAN_VISIT_BUDGET } from '../audit-scan';

// 임시 트리 헬퍼 — 각 테스트가 독립된 폴더에서 돌게 해 서로 오염되지 않게 한다.
function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-scan-test-'));
}
function rmTemp(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
}

// ── normalizeScanRoots ──────────────────────────────────────────────
test('normalizeScanRoots: 존재하지 않는 경로는 제외한다', () => {
  const tmp = mkTemp();
  try {
    const result = normalizeScanRoots([tmp, path.join(tmp, 'nope-does-not-exist')]);
    assert.deepEqual(result, [fs.realpathSync(tmp)]);
  } finally { rmTemp(tmp); }
});

test('normalizeScanRoots: 같은 폴더가 중복으로 들어오면 한 번만 남긴다', () => {
  const tmp = mkTemp();
  try {
    const result = normalizeScanRoots([tmp, tmp, tmp]);
    assert.equal(result.length, 1);
  } finally { rmTemp(tmp); }
});

test('normalizeScanRoots: 부모·자식 관계면 자식(중첩)을 제거하고 부모만 남긴다', () => {
  const tmp = mkTemp();
  try {
    const child = path.join(tmp, 'child');
    fs.mkdirSync(child);
    const result = normalizeScanRoots([tmp, child]);
    assert.equal(result.length, 1);
    assert.equal(result[0], fs.realpathSync(tmp));
  } finally { rmTemp(tmp); }
});

test('normalizeScanRoots: 파일(디렉터리 아님) 경로는 제외한다', () => {
  const tmp = mkTemp();
  try {
    const file = path.join(tmp, 'a-file.txt');
    fs.writeFileSync(file, 'x');
    const result = normalizeScanRoots([file]);
    assert.deepEqual(result, []);
  } finally { rmTemp(tmp); }
});

test('normalizeScanRoots: 무관한 두 폴더는 둘 다 남긴다(중첩 아님)', () => {
  const tmp = mkTemp();
  try {
    const a = path.join(tmp, 'a'); fs.mkdirSync(a);
    const b = path.join(tmp, 'b'); fs.mkdirSync(b);
    const result = normalizeScanRoots([a, b]);
    assert.equal(result.length, 2);
  } finally { rmTemp(tmp); }
});

// ── recentOutputFiles ───────────────────────────────────────────────
test('recentOutputFiles: 제외 목록(node_modules 등)에 든 폴더는 순회하지 않는다', () => {
  const tmp = mkTemp();
  try {
    const nm = path.join(tmp, 'node_modules'); fs.mkdirSync(nm);
    fs.writeFileSync(path.join(nm, 'pkg.js'), 'x');
    fs.writeFileSync(path.join(tmp, 'real-output.txt'), 'y');
    const since = Date.now() - 60_000;
    const { files } = recentOutputFiles([tmp], tmp, since);
    assert.deepEqual(files, ['real-output.txt']);
  } finally { rmTemp(tmp); }
});

test('recentOutputFiles: 숨김 폴더는 기본 제외되지만 허용목록(.github)은 통과한다', () => {
  const tmp = mkTemp();
  try {
    const hiddenOther = path.join(tmp, '.venv'); fs.mkdirSync(hiddenOther);
    fs.writeFileSync(path.join(hiddenOther, 'lib.py'), 'x');
    const gh = path.join(tmp, '.github'); fs.mkdirSync(gh);
    fs.writeFileSync(path.join(gh, 'workflow.yml'), 'y');
    const since = Date.now() - 60_000;
    const { files } = recentOutputFiles([tmp], tmp, since);
    assert.deepEqual(files.sort(), ['.github/workflow.yml']);
  } finally { rmTemp(tmp); }
});

test('recentOutputFiles: sinceMs 이전에 수정된 파일은 제외한다', () => {
  const tmp = mkTemp();
  try {
    const old = path.join(tmp, 'old.txt');
    fs.writeFileSync(old, 'x');
    const oldTime = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(old, oldTime, oldTime);
    fs.writeFileSync(path.join(tmp, 'new.txt'), 'y'); // 방금 생성 — mtime now
    const since = Date.now() - 60_000; // 1분 전 이후만
    const { files } = recentOutputFiles([tmp], tmp, since);
    assert.deepEqual(files, ['new.txt']);
  } finally { rmTemp(tmp); }
});

test('recentOutputFiles: relBase 기준 상대경로로 반환한다', () => {
  const tmp = mkTemp();
  try {
    const sub = path.join(tmp, 'sub'); fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'out.txt'), 'x');
    const since = Date.now() - 60_000;
    const { files } = recentOutputFiles([tmp], tmp, since);
    assert.deepEqual(files, ['sub/out.txt']);
  } finally { rmTemp(tmp); }
});

test('recentOutputFiles: 같은 파일이 두 스캔 루트에 겹쳐도 중복 없이 한 번만 반환한다', () => {
  const tmp = mkTemp();
  try {
    fs.writeFileSync(path.join(tmp, 'dup.txt'), 'x');
    const since = Date.now() - 60_000;
    // 같은 경로를 두 번 스캔 대상으로 넘겨도(normalizeScanRoots가 정리하지만, seen 가드도 이중 방어)
    const { files } = recentOutputFiles([tmp, tmp], tmp, since);
    assert.deepEqual(files, ['dup.txt']);
  } finally { rmTemp(tmp); }
});

test('recentOutputFiles: 방문 예산(SCAN_VISIT_BUDGET)을 넘기면 truncated=true 를 보고한다', () => {
  const tmp = mkTemp();
  try {
    // 예산 5000 을 넘기려고 파일을 대량 생성하면 테스트가 느려진다 — 대신 깊이 상한(depth>3)으로
    // truncated 를 유발한다: SCAN_VISIT_BUDGET 상수는 굳이 재현하지 않고, 더 값싼 depth 상한 경로로
    // 동일 필드(truncated)의 참 계약을 검증한다.
    let dir = tmp;
    for (let i = 0; i < 6; i++) { dir = path.join(dir, `d${i}`); fs.mkdirSync(dir); }
    fs.writeFileSync(path.join(dir, 'deep.txt'), 'x'); // depth 6 — depth>3 컷에 걸림
    const since = Date.now() - 60_000;
    const { files, truncated } = recentOutputFiles([tmp], tmp, since);
    assert.deepEqual(files, []);
    assert.equal(truncated, true);
  } finally { rmTemp(tmp); }
});

test('recentOutputFiles: 방문 예산(SCAN_VISIT_BUDGET)을 넘기면 out이 20건 미만이어도 truncated=true', { timeout: 30_000 }, () => {
  const tmp = mkTemp();
  try {
    // 점 파일(.f숫자)은 숨김·허용목록 밖이라 out 에 쌓이지 않고 스킵되지만 visited 는 계속 오른다 —
    // out.length<20 인 채로 방문 예산만으로 truncated 가 되는 경로를 out 상한(20건) 경로와 분리해 검증한다.
    const count = SCAN_VISIT_BUDGET + 5;
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(tmp, `.f${i}`), '');
    const since = Date.now() - 60_000;
    const { files, truncated } = recentOutputFiles([tmp], tmp, since);
    assert.deepEqual(files, []);
    assert.equal(truncated, true);
  } finally { rmTemp(tmp); }
});

test('recentOutputFiles: _audit·_작업이력.md 는 스캔 대상에서 제외한다', () => {
  const tmp = mkTemp();
  try {
    const audit = path.join(tmp, '_audit'); fs.mkdirSync(audit);
    fs.writeFileSync(path.join(audit, '감사이력.md'), 'x');
    fs.writeFileSync(path.join(tmp, '_작업이력.md'), 'y');
    fs.writeFileSync(path.join(tmp, 'keep.txt'), 'z');
    const since = Date.now() - 60_000;
    const { files } = recentOutputFiles([tmp], tmp, since);
    assert.deepEqual(files, ['keep.txt']);
  } finally { rmTemp(tmp); }
});

// ── recordDispatchResponse ───────────────────────────────────────────
function meta(kv: Record<string, string>): string {
  return '[[RESPMETA ' + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('|') + ']]';
}

test('recordDispatchResponse: t- 접두가 아닌 commit 은 거부(기록 안 함)', () => {
  const tmp = mkTemp();
  try {
    const auditDir = path.join(tmp, '_audit');
    const cmd = `[감사 대응] 내용 ${meta({ auditDir, commit: 'abc1234', worker: 'w' })}`;
    recordDispatchResponse(cmd, '대응 완료', auditDir, 'w');
    assert.equal(fs.existsSync(path.join(auditDir, '대응이력.md')), false);
  } finally { rmTemp(tmp); }
});

test('recordDispatchResponse: 마커 좌표가 러너 계산 경로와 다르면 거부(기록 안 함)', () => {
  const tmp = mkTemp();
  try {
    const auditDir = path.join(tmp, '_audit');
    const wrongDir = path.join(tmp, '_other_audit');
    const cmd = `[감사 대응] 내용 ${meta({ auditDir: wrongDir, commit: 't-abc12345', worker: 'w' })}`;
    recordDispatchResponse(cmd, '대응 완료', auditDir, 'w'); // expectedAuditDir=auditDir, 마커=wrongDir
    assert.equal(fs.existsSync(path.join(auditDir, '대응이력.md')), false);
    assert.equal(fs.existsSync(path.join(wrongDir, '대응이력.md')), false);
  } finally { rmTemp(tmp); }
});

test('recordDispatchResponse: 정상 케이스 — t- 접두 + 좌표 일치면 대응이력.md 에 기록한다', () => {
  const tmp = mkTemp();
  try {
    const auditDir = path.join(tmp, '_audit');
    const cmd = `[감사 대응] 내용 ${meta({ auditDir, commit: 't-abc12345', worker: '알파' })}`;
    recordDispatchResponse(cmd, '대응 완료 내용', auditDir, '알파');
    const file = path.join(auditDir, '대응이력.md');
    assert.equal(fs.existsSync(file), true);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /## 커밋 t-abc12345 대응/);
    assert.match(text, /\[actor:daemon:알파\]/);
    assert.match(text, /대응 완료 내용/);
  } finally { rmTemp(tmp); }
});

test('recordDispatchResponse: 같은 commit 헤더가 이미 있으면 중복 기록하지 않는다', () => {
  const tmp = mkTemp();
  try {
    const auditDir = path.join(tmp, '_audit');
    const cmd = `[감사 대응] 내용 ${meta({ auditDir, commit: 't-dup00001', worker: '알파' })}`;
    recordDispatchResponse(cmd, '첫 기록', auditDir, '알파');
    const file = path.join(auditDir, '대응이력.md');
    const firstText = fs.readFileSync(file, 'utf8');
    recordDispatchResponse(cmd, '두번째 시도(무시돼야 함)', auditDir, '알파');
    const secondText = fs.readFileSync(file, 'utf8');
    assert.equal(secondText, firstText); // 변화 없어야 함(중복 가드)
    assert.equal((secondText.match(/## 커밋 t-dup00001 대응/g) || []).length, 1);
  } finally { rmTemp(tmp); }
});

test('recordDispatchResponse: RESPMETA 마커가 없으면 아무 것도 하지 않는다', () => {
  const tmp = mkTemp();
  try {
    const auditDir = path.join(tmp, '_audit');
    recordDispatchResponse('[감사 대응] 마커 없는 텍스트', '결과', auditDir, 'w');
    assert.equal(fs.existsSync(path.join(auditDir, '대응이력.md')), false);
  } finally { rmTemp(tmp); }
});

test('recordDispatchResponse: 인용된 앞쪽 마커를 무시하고 마지막(진짜) 마커만 신뢰한다', () => {
  const tmp = mkTemp();
  try {
    const auditDir = path.join(tmp, '_audit');
    // 감사 의견 인용 속에 축약/오염된 앞쪽 마커가 있어도, 러너가 실제로 붙인 마지막 마커를 써야 한다.
    const quoted = '[[RESPMETA auditDir=/bogus|commit=t-00000000|worker=x]]';
    const real = meta({ auditDir, commit: 't-real0001', worker: '알파' });
    const cmd = `[감사 대응] 인용: ${quoted} 본문... ${real}`;
    recordDispatchResponse(cmd, '기록됨', auditDir, '알파');
    const file = path.join(auditDir, '대응이력.md');
    assert.equal(fs.existsSync(file), true);
    assert.match(fs.readFileSync(file, 'utf8'), /## 커밋 t-real0001 대응/);
  } finally { rmTemp(tmp); }
});
