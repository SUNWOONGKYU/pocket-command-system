// audit-integrity-check.js 회귀 테스트 — verifyChain / verifyPrefix / parseLine / sha256.
//   핵심 보안 경로(SHA-256 프리픽스 체인)를 인메모리 픽스처로 검증한다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { sha256, parseLine, verifyChain, verifyPrefix } = require('../audit-integrity-check.js');

// ---------- sha256 ----------

test('sha256: 빈 버퍼', () => {
  const expected = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  assert.equal(sha256(Buffer.alloc(0)), expected);
});

test('sha256: 알려진 값 (abc)', () => {
  const result = sha256(Buffer.from('abc'));
  assert.equal(result.length, 64, 'SHA-256 출력은 항상 64 hex chars');
  assert.match(result, /^[0-9a-f]{64}$/, '소문자 hex');
  // 래퍼 정확성: Node crypto 직접 호출과 동일해야 한다
  const direct = crypto.createHash('sha256').update(Buffer.from('abc')).digest('hex');
  assert.equal(result, direct);
});

// ---------- parseLine ----------

test('parseLine: 정상 4필드 라인', () => {
  const hash = 'a'.repeat(64);
  const chain = 'b'.repeat(64);
  const line = `2026-07-25T12:00:00.000Z|1024|${hash}|${chain}`;
  const result = parseLine(line);
  assert.ok(result);
  assert.equal(result.byteLen, 1024);
  assert.equal(result.prefixHash, hash);
  assert.equal(result.chainHash, chain);
  assert.equal(result.raw, line);
});

test('parseLine: 필드 수 부족(3개) → null', () => {
  assert.equal(parseLine('ts|1024|abc'), null);
});

test('parseLine: 필드 수 초과(5개) → null', () => {
  const h = 'a'.repeat(64);
  assert.equal(parseLine(`ts|1024|${h}|${h}|extra`), null);
});

test('parseLine: byteLen 음수 → null', () => {
  const h = 'a'.repeat(64);
  assert.equal(parseLine(`ts|-1|${h}|${h}`), null);
});

test('parseLine: prefixHash 길이 부족(63자) → null', () => {
  const shortHash = 'a'.repeat(63);
  const h = 'a'.repeat(64);
  assert.equal(parseLine(`ts|0|${shortHash}|${h}`), null);
});

test('parseLine: chainHash 비hex 문자 포함 → null', () => {
  const h = 'a'.repeat(64);
  const badChain = 'z'.repeat(64);
  assert.equal(parseLine(`ts|0|${h}|${badChain}`), null);
});

// ---------- verifyChain 헬퍼 ----------

function buildChainLines(count, content = 'hello') {
  // count 개의 정상 체인 줄을 생성한다.
  const lines = [];
  let prevRaw = '';
  for (let i = 0; i < count; i++) {
    const ts = `2026-07-25T12:00:0${i}.000Z`;
    const buf = Buffer.from(content + i);
    const byteLen = buf.length;
    const prefixHash = sha256(buf);
    const chainHash = sha256(prevRaw + '\n' + `${ts}|${byteLen}|${prefixHash}`);
    const line = `${ts}|${byteLen}|${prefixHash}|${chainHash}`;
    lines.push(line);
    prevRaw = line;
  }
  return lines;
}

// ---------- verifyChain ----------

test('verifyChain: 빈 줄 배열 → ok:true', () => {
  const result = verifyChain([]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, []);
  assert.deepEqual(result.problems, []);
});

test('verifyChain: 정상 1줄 체인 → ok:true', () => {
  const lines = buildChainLines(1);
  const result = verifyChain(lines);
  assert.equal(result.ok, true);
  assert.equal(result.parsed.length, 1);
});

test('verifyChain: 정상 5줄 체인 → ok:true', () => {
  const lines = buildChainLines(5);
  const result = verifyChain(lines);
  assert.equal(result.ok, true);
  assert.equal(result.parsed.length, 5);
});

test('verifyChain: 중간 줄 하나 삭제 시 → ok:false (체인 끊김)', () => {
  const lines = buildChainLines(5);
  const tampered = [...lines.slice(0, 2), ...lines.slice(3)]; // 3번째 줄 삭제
  const result = verifyChain(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.problems.length > 0);
});

test('verifyChain: 첫 줄 값 변조 → ok:false', () => {
  const lines = buildChainLines(3);
  const tampered = [lines[0].replace(/\d{4}/, '9999'), ...lines.slice(1)]; // 첫 줄 연도 조작
  const result = verifyChain(tampered);
  assert.equal(result.ok, false);
});

test('verifyChain: 형식 오류 줄(4필드 아님) → ok:false + 사유 보고', () => {
  const result = verifyChain(['not|a|valid']);
  assert.equal(result.ok, false);
  assert.ok(result.problems[0].includes('형식 오류'));
});

test('verifyChain: 마지막 줄만 변조 → ok:false (그 지점 보고)', () => {
  const lines = buildChainLines(4);
  const last = lines[lines.length - 1];
  const tampered = [...lines.slice(0, -1), last.replace(/\|([0-9a-f]{64})\|/, `|${'c'.repeat(64)}|`)];
  const result = verifyChain(tampered);
  assert.equal(result.ok, false);
});

// ---------- verifyPrefix ----------

test('verifyPrefix: 파싱된 줄 0개 → ok:true (아직 기록 없음)', () => {
  const result = verifyPrefix([], Buffer.from('anything'));
  assert.equal(result.ok, true);
});

test('verifyPrefix: 현재 파일 내용이 기록 당시와 동일 → ok:true', () => {
  const content = Buffer.from('감사이력 내용');
  const ts = '2026-07-25T12:00:00.000Z';
  const byteLen = content.length;
  const prefixHash = sha256(content);
  // 체인 첫 줄 (prevRaw = '')
  const chainHash = sha256('' + '\n' + `${ts}|${byteLen}|${prefixHash}`);
  const parsed = [{ ts, byteLen, prefixHash, chainHash, raw: `${ts}|${byteLen}|${prefixHash}|${chainHash}` }];
  const result = verifyPrefix(parsed, content);
  assert.equal(result.ok, true);
});

test('verifyPrefix: 현재 파일 앞부분이 기록 당시와 다름 → ok:false (위변조)', () => {
  const original = Buffer.from('원본 감사이력');
  const ts = '2026-07-25T12:00:00.000Z';
  const byteLen = original.length;
  const prefixHash = sha256(original);
  const chainHash = sha256('' + '\n' + `${ts}|${byteLen}|${prefixHash}`);
  const parsed = [{ ts, byteLen, prefixHash, chainHash, raw: '' }];
  const tampered = Buffer.from('조작된 감사이역'); // 내용 변조
  const result = verifyPrefix(parsed, tampered);
  assert.equal(result.ok, false);
  assert.ok(result.problems[0].includes('무결성 불일치'));
});

test('verifyPrefix: 현재 파일이 기록 당시보다 작아짐(삭제) → ok:false', () => {
  const content = Buffer.from('충분히 긴 감사이력 내용');
  const ts = '2026-07-25T12:00:00.000Z';
  const byteLen = content.length;
  const prefixHash = sha256(content);
  const chainHash = sha256('' + '\n' + `${ts}|${byteLen}|${prefixHash}`);
  const parsed = [{ ts, byteLen, prefixHash, chainHash, raw: '' }];
  const shrunk = content.subarray(0, 3); // 앞 3바이트만 남김
  const result = verifyPrefix(parsed, shrunk);
  assert.equal(result.ok, false);
  assert.ok(result.problems[0].includes('삭제/축소'));
});

test('verifyPrefix: 기록 이후 내용이 더 append됨(정상) → ok:true', () => {
  const original = Buffer.from('원본 내용');
  const ts = '2026-07-25T12:00:00.000Z';
  const byteLen = original.length;
  const prefixHash = sha256(original);
  const chainHash = sha256('' + '\n' + `${ts}|${byteLen}|${prefixHash}`);
  const parsed = [{ ts, byteLen, prefixHash, chainHash, raw: '' }];
  // 뒤에 새 내용 append
  const grown = Buffer.concat([original, Buffer.from('\n새로운 감사 기록')]);
  // grown의 앞 byteLen바이트는 original과 동일 → 검증 통과
  const result = verifyPrefix(parsed, grown);
  assert.equal(result.ok, true);
});

// ---------- 통합 테스트 (FS I/O 경로 — tmp 디렉터리) ----------
// B안 설계(감사관은 append만, 해시는 이 스크립트가 계산)의 실제 FS 경로를 검증한다.
// runRecord·runVerify는 process.argv에 의존하므로 child_process로 호출한다.

test('통합: --record 후 검증 통과, append 후 재기록·재검증 통과', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-test-'));
  const vaultFile = path.join(tmpDir, '감사이력_원본.md');
  const script = path.join(__dirname, '..', 'audit-integrity-check.js');

  // 1. vault 파일 초기 내용
  fs.writeFileSync(vaultFile, '첫 번째 감사 기록\n');

  // 2. --record: integrity.log 생성
  execFileSync(process.execPath, [script, '--vault', tmpDir, '--record']);
  assert.ok(fs.existsSync(path.join(tmpDir, 'integrity.log')), 'integrity.log 생성됨');

  // 3. 검증 (exit 0 = 통과)
  execFileSync(process.execPath, [script, '--vault', tmpDir]);

  // 4. vault에 새 내용 append 후 재기록
  fs.appendFileSync(vaultFile, '두 번째 감사 기록\n');
  execFileSync(process.execPath, [script, '--vault', tmpDir, '--record']);

  // 5. 재검증 (exit 0 = 통과)
  execFileSync(process.execPath, [script, '--vault', tmpDir]);

  // cleanup
  fs.rmSync(tmpDir, { recursive: true });
});
