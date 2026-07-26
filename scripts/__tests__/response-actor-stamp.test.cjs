// response-actor-stamp.js 회귀 테스트 — isUnchanged/needsBaseline/computeStamp.
//   CV Round3 Low-2: 워터마크 상태 전환·구버전 상태 호환·펜스 폴백 경로가 검증되지 않았다.
//   이 파일을 require() 해도 훅 본체(main)는 require.main===module 가드 때문에 자동 실행되지
//   않는다 — 그래서 stdin 동기 읽기·process.exit(0) 부작용 없이 순수 함수만 테스트할 수 있다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isUnchanged, needsBaseline, computeStamp } = require('../response-actor-stamp.js');
const RESP_SCAN = require('../audit-response-scan.cjs');

// ── isUnchanged (파일 mtime bail-check) ──────────────────────────────
test('isUnchanged: state 없음(첫 실행) → false(처리해야 함)', () => {
  assert.equal(isUnchanged(null, 123), false);
});

test('isUnchanged: state.mtimeMs 가 현재와 같으면 true(재처리 불필요)', () => {
  assert.equal(isUnchanged({ mtimeMs: 555, stampedThroughLine: 10 }, 555), true);
});

test('isUnchanged: state.mtimeMs 가 다르면 false(파일이 바뀜 — 재처리)', () => {
  assert.equal(isUnchanged({ mtimeMs: 555, stampedThroughLine: 10 }, 999), false);
});

// ── needsBaseline (구버전 상태 호환) ──────────────────────────────────
test('needsBaseline: state 자체가 없으면(첫 실행) true', () => {
  assert.equal(needsBaseline(null), true);
});

test('needsBaseline: 구버전 상태(stampedThroughLine 없음)면 true', () => {
  assert.equal(needsBaseline({ mtimeMs: 1 }), true);
});

test('needsBaseline: stampedThroughLine 이 숫자로 있으면 false', () => {
  assert.equal(needsBaseline({ mtimeMs: 1, stampedThroughLine: 0 }), false);
  assert.equal(needsBaseline({ mtimeMs: 1, stampedThroughLine: 42 }), false);
});

// ── computeStamp (워터마크 위 헤더에만 스탬프 적용) ───────────────────
test('computeStamp: 데몬(actor 있음) — [actor:daemon:<name>] 스탬프를 붙인다', () => {
  const lines = ['## 커밋 abc123 대응 — 2026-07-27 10:00 (알파)', '본문'];
  const { lines: out, changed, newLeaderResponses } = computeStamp(lines, [0], 0, '알파');
  assert.equal(changed, true);
  assert.equal(out[0], '## 커밋 abc123 대응 — 2026-07-27 10:00 (알파) [actor:daemon:알파]');
  assert.deepEqual(newLeaderResponses, []); // 데몬 대응은 통지 대상 아님
});

test('computeStamp: 대화형(actor 없음) — [actor:leader] 스탬프 + 통지 목록에 추가', () => {
  const lines = ['## 커밋 abc123 대응 — 2026-07-27 10:00 (소대장)', '실제 대응 본문 첫 줄'];
  const { lines: out, changed, newLeaderResponses } = computeStamp(lines, [0], 0, '');
  assert.equal(changed, true);
  assert.equal(out[0], '## 커밋 abc123 대응 — 2026-07-27 10:00 (소대장) [actor:leader]');
  assert.equal(newLeaderResponses.length, 1);
  assert.equal(newLeaderResponses[0].header, '## 커밋 abc123 대응 — 2026-07-27 10:00 (소대장)'); // 스탬프 붙기 전 원본 헤더
  assert.equal(newLeaderResponses[0].body, '실제 대응 본문 첫 줄');
});

test('computeStamp: 워터마크 아래(과거분) 헤더는 건드리지 않는다', () => {
  const lines = ['## 커밋 old111 대응 — 과거', '## 커밋 new222 대응 — 신규'];
  // stampedThroughLine=1 → 인덱스 0(과거)은 건드리지 않고 인덱스 1(신규)만 대상.
  const { lines: out, changed } = computeStamp(lines, [0, 1], 1, '알파');
  assert.equal(out[0], '## 커밋 old111 대응 — 과거'); // 그대로
  assert.match(out[1], /\[actor:daemon:알파\]$/);
  assert.equal(changed, true);
});

test('computeStamp: 이미 [actor:] 표식이 있는 줄은 멱등 — 다시 건드리지 않는다', () => {
  const lines = ['## 커밋 abc123 대응 — 이미 표식됨 [actor:leader]'];
  const { lines: out, changed } = computeStamp(lines, [0], 0, '');
  assert.equal(out[0], lines[0]); // 변화 없음
  assert.equal(changed, false);
});

test('computeStamp: CRLF(\\r로 끝나는 줄)도 개행 문자를 보존한 채 스탬프를 붙인다', () => {
  const lines = ['## 커밋 abc123 대응 — 2026-07-27 (알파)\r', '본문\r'];
  const { lines: out } = computeStamp(lines, [0], 0, '알파');
  assert.equal(out[0], '## 커밋 abc123 대응 — 2026-07-27 (알파) [actor:daemon:알파]\r');
});

test('computeStamp: 대상 헤더가 없으면(빈 headerIdx) changed=false, 통지 없음', () => {
  const lines = ['평범한 텍스트'];
  const { lines: out, changed, newLeaderResponses } = computeStamp(lines, [], 0, '알파');
  assert.deepEqual(out, lines);
  assert.equal(changed, false);
  assert.deepEqual(newLeaderResponses, []);
});

// ── 펜스 폴백 경로 — RESP_SCAN.scanSafe(공용 스캐너)와 조합해 실제 파이프라인처럼 검증 ──
test('통합: 코드펜스로 인용된 헤더는 scanSafe가 애초에 넘기지 않으므로 스탬프 대상에서 빠진다', () => {
  const text = [
    '```md',
    '## 커밋 abcdef01 대응 — 인용된 예시, 실제 대응 아님',
    '```',
    '## 커밋 1234abcd 대응 — 진짜 신규 대응',
  ].join('\n');
  const lines = text.split('\n');
  const { indices } = RESP_SCAN.scanSafe(lines, () => {});
  const { lines: out, changed } = computeStamp(lines, indices, 0, '알파');
  assert.equal(out.some((l) => l.includes('abcdef01') && l.includes('[actor:')), false);
  assert.equal(out.some((l) => l.includes('1234abcd') && l.includes('[actor:daemon:알파]')), true);
  assert.equal(changed, true);
});

test('통합: 펜스가 닫히지 않으면 scanSafe가 비인식 폴백해 원문 헤더까지 스탬프 대상이 된다', () => {
  const lines = [
    '```md',
    '## 커밋 abc123 대응 — 펜스가 끝까지 안 닫힘',
  ];
  let fellBack = false;
  const { indices } = RESP_SCAN.scanSafe(lines, () => { fellBack = true; });
  assert.equal(fellBack, true);
  const { lines: out, changed } = computeStamp(lines, indices, 0, '');
  assert.equal(changed, true);
  assert.match(out[1], /\[actor:leader\]$/);
});
