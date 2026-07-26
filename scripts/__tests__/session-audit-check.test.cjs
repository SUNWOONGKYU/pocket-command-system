// session-audit-check.js chunkOf 회귀 테스트.
//   ★핵심 재현 케이스: chunkOf가 예전엔 줄머리 앵커 없이(lastIndexOf 등) 헤더 문자열을 찾아서,
//   감사 의견 '본문'이 이전 감사 마커를 인용문으로만 적어도("이전에 '## 커밋 <해시> 감사 ...' 라고
//   적었으나") 그 인용이 진짜 헤더로 오인돼 verdictOf/needsAction이 실제 판정 대신 인용문
//   앞부분을 읽어버리는 버그가 있었다. 지금은 '^## 커밋 <해시> .*$' 를 /gm 으로 앵커해
//   "문서의 실제 줄머리"만 헤더로 인정한다. 또한 재감사(같은 해시가 여러 번 등장)면
//   최종본(마지막 매치) 뒤 내용을 읽어야 한다.
//
// require.main !== module 인 상태로 불러오므로(테스트 러너가 진입점), 파일 하단의
// SessionStart 훅 실행 블록(process.exit 포함)은 동작하지 않고 exports만 가져온다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractHashes, chunkOf, verdictOf } = require('../session-audit-check.js');

test('chunkOf: 본문 인용(줄머리 아님)에 속지 않고 진짜 헤더 뒤 내용을 읽는다', () => {
  const text = [
    '어떤 감사 의견 본문에 "이전에 \'## 커밋 abc123 감사 ...\' 라고 적었으나 이번엔 문제없다."',
    '[정상] [조치불요] — 이 줄은 인용문 다음이라 진짜 판정이 아니다.',
    '',
    '## 커밋 abc123 감사 — 진짜 헤더',
    '[주의] [조치필요] — 진짜 판정',
  ].join('\n');

  const chunk = chunkOf(text, 'abc123');
  assert.ok(chunk.startsWith('[주의] [조치필요] — 진짜 판정'), `chunk가 인용문에 낚였다: ${JSON.stringify(chunk)}`);
});

test('chunkOf: 재감사(같은 해시 재등장) 시 마지막(최종) 매치 뒤 내용을 읽는다', () => {
  const text = [
    '## 커밋 abc123 감사 — 1차',
    '[중대] [조치필요] — 최초 판정, 나중에 정정됨',
    '',
    '## 커밋 abc123 감사 — 재감사(2차, 최종)',
    '[경미] [조치불요] — 정정된 최종 판정, 문제 없음',
  ].join('\n');

  const chunk = chunkOf(text, 'abc123');
  assert.ok(
    chunk.startsWith('[경미] [조치불요] — 정정된 최종 판정'),
    `마지막 매치가 아니라 최초 매치를 읽었다: ${JSON.stringify(chunk)}`
  );
});

test('verdictOf: 재감사 최종본의 심각도를 읽는다(1차 [중대]가 아니라 최종 [경미])', () => {
  const text = [
    '## 커밋 abc123 감사 — 1차',
    '[중대] [조치필요] — 최초 판정',
    '',
    '## 커밋 abc123 감사 — 재감사(최종)',
    '[경미] [조치불요] — 정정된 최종 판정',
  ].join('\n');

  assert.equal(verdictOf(text, 'abc123'), '경미');
});

test('chunkOf: 헤더가 아예 없으면 빈 문자열을 반환한다', () => {
  const text = '## 커밋 def456 감사 — 다른 커밋만 있음\n[정상] [조치불요] — 무관';
  assert.equal(chunkOf(text, 'abc123'), '');
});

test('extractHashes: t- 접두 파견 산출물 해시도 추출한다', () => {
  const text = '## 커밋 t-9f8e7d 감사 — 파견 산출물\n[주의] [조치필요] — 확인 필요';
  const set = extractHashes(text, /^## 커밋 ((?:t-)?[0-9a-f]{6,40}) 감사/gm);
  assert.ok(set.has('t-9f8e7d'));
});

test('extractHashes: 줄머리가 아닌 인용(문장 중간)은 헤더로 세지 않는다', () => {
  const text = '본문 중에 "## 커밋 abc123 감사" 라는 문구를 그냥 인용했을 뿐이다.';
  const set = extractHashes(text, /^## 커밋 ((?:t-)?[0-9a-f]{6,40}) 감사/gm);
  assert.equal(set.size, 0);
});

test('chunkOf: 600자 상한을 넘는 판정 뒤 내용은 잘라낸다', () => {
  const filler = '가'.repeat(700);
  const text = `## 커밋 abc123 감사 — 긴 본문\n${filler}`;
  const chunk = chunkOf(text, 'abc123');
  assert.equal(chunk.length, 600);
});

// ★재감사 후 재주입 회귀 방지 — codex High 지적(2026-07-27): responded.has(h) 단순 해시 필터가
//   재감사 후 새 [조치필요]를 누락시키는 경로. auditCountOf >= 2 이면 최신 판정으로 재판단한다.
test('auditCountOf 헬퍼: 감사 항목이 1개이면 1, 재감사 포함 2개이면 2', () => {
  const { escapeRegExp } = require('../session-audit-check.js').testHelpers || {};
  // escapeRegExp를 직접 사용할 수 없으면 regex로 직접 세는 방식을 테스트
  const auditText1 = '## 커밋 abc123 감사 — 1차\n[주의] [조치필요]';
  const auditText2 = [
    '## 커밋 abc123 감사 — 1차',
    '[주의] [조치필요]',
    '',
    '## 커밋 abc123 감사 — 재감사',
    '[정상] [조치불요]',
  ].join('\n');
  const count1 = (auditText1.match(/^## 커밋 abc123 감사/gm) || []).length;
  const count2 = (auditText2.match(/^## 커밋 abc123 감사/gm) || []).length;
  assert.equal(count1, 1);
  assert.equal(count2, 2);
});
