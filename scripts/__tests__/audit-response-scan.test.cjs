// audit-response-scan.cjs 회귀 테스트 — 대응이력.md 헤더 스캐너.
//   핵심 실사고: 파견 분대장이 ```md 블록으로 '인용 헤더'를 되돌려 보내면, 코드펜스를
//   인식 못 하는 소비처는 그걸 "이미 대응함"으로 잘못 읽어 ①정당한 재요청이 막히고
//   ②미응답 목록에서 사라진다. 이 파일 하나(scan/scanSafe/respondedIds)가 세 소비처
//   공용 SSOT이므로 펜스 종류·중첩·미닫힘까지 전부 검증한다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scan, scanSafe, respondedIds } = require('../audit-response-scan.cjs');

test('코드펜스로 인용된 헤더는 제외한다', () => {
  const text = [
    '```md',
    '## 커밋 abc123 대응 — 인용된 예시일 뿐, 실제 대응 아님',
    '```',
  ].join('\n');
  const ids = respondedIds(text);
  assert.equal(ids.has('abc123'), false);
});

test('펜스 밖의 진짜 헤더는 인식한다', () => {
  const text = [
    '## 커밋 abc123 대응 — 2026-07-25 10:00 (소대장)',
    '실제 대응 내용.',
  ].join('\n');
  const ids = respondedIds(text);
  assert.equal(ids.has('abc123'), true);
});

test('같은 식별자라도 인용(펜스 안)만 있고 진짜 헤더가 없으면 미응답 취급', () => {
  const text = [
    '```md',
    '## 커밋 abc123 대응 — 인용',
    '```',
    '## 커밋 def456 대응 — 진짜 대응(다른 커밋)',
  ].join('\n');
  const ids = respondedIds(text);
  assert.equal(ids.has('abc123'), false);
  assert.equal(ids.has('def456'), true);
});

test('중첩 펜스: 4-백틱 바깥 안에 3-백틱 인용이 있어도 바깥이 진짜로 닫힐 때까지 안쪽으로 취급', () => {
  // 4-backtick으로 열고, 그 안에 3-backtick 예시 블록이 등장해도(짧은 펜스는 내용일 뿐)
  // 같은 문자·길이 이상인 4-backtick이 나와야 비로소 닫힌다(CommonMark 규칙).
  const text = [
    '````md',
    '```',
    '## 커밋 abc123 대응 — 3-백틱 안쪽 예시, 인용',
    '```',
    '````',
    '## 커밋 abc123 대응 — 바깥으로 나온 뒤의 진짜 헤더',
  ].join('\n');
  const { indices } = scan(text.split('\n'));
  assert.equal(indices.length, 1);
  assert.equal(text.split('\n')[indices[0]].includes('바깥으로 나온 뒤의 진짜 헤더'), true);
});

test('미닫힘 펜스: EOF까지 안 닫히면 open=true 로 보고하고, scanSafe는 비인식으로 폴백한다', () => {
  const lines = [
    '```md',
    '## 커밋 abc123 대응 — 펜스가 끝까지 안 닫힘',
  ];
  const withFence = scan(lines, { useFence: true });
  assert.equal(withFence.open, true);
  assert.equal(withFence.indices.length, 0); // 펜스 안이라 인식 안 됨

  let fellBack = false;
  const safe = scanSafe(lines, () => { fellBack = true; });
  assert.equal(fellBack, true);
  assert.equal(safe.indices.length, 1); // 폴백 후엔 원문 스캔이라 헤더가 잡힌다
});

test('~~~ 물결 펜스도 백틱과 동일하게 인식한다', () => {
  const text = [
    '~~~md',
    '## 커밋 abc123 대응 — 물결 펜스 안, 인용',
    '~~~',
    '## 커밋 abc123 대응 — 물결 펜스 밖, 진짜',
  ].join('\n');
  const ids = respondedIds(text);
  assert.equal(ids.has('abc123'), true);
  const { indices } = scan(text.split('\n'));
  assert.equal(indices.length, 1);
});

test('t- 접두 식별자(파견 산출물)를 인식한다', () => {
  const text = '## 커밋 t-9f8e7d 대응 — 파견 분대장 산출물 대응';
  const ids = respondedIds(text);
  assert.equal(ids.has('t-9f8e7d'), true);
});

test('respondedIds: 펜스 다른 문자/짧은 펜스는 바깥 펜스를 닫지 못한다', () => {
  // 백틱으로 연 펜스 안에서 물결 펜스가 나와도(다른 문자) 닫히지 않는다.
  const text = [
    '```md',
    '~~~',
    '## 커밋 abc123 대응 — 여전히 백틱 펜스 안',
    '~~~',
    '```',
  ].join('\n');
  const ids = respondedIds(text);
  assert.equal(ids.has('abc123'), false);
});

// ★외부 검증 지적 High-1(2026-07-27): scanSafe의 미닫힘 폴백은 Stop 훅 스탬프를 위해 넣은
//   것인데, respondedIds(재적재 가드·미응답 판정)도 같은 scanSafe를 그대로 써서 인용 헤더가
//   "이미 대응함"으로 승격돼 정당한 대응 요청이 조용히 막히는 사고가 날 수 있었다.
//   respondedIds는 폴백을 꺼야 하고(allowFallback:false), scanSafe 자체는 기본값(true)을 유지해야
//   Stop 훅 쪽 동작은 그대로 남아야 한다 — 두 방향을 모두 검증한다.
test('High-1: respondedIds는 펜스가 안 닫혀도 폴백하지 않는다 — 인용 헤더를 대응으로 승격시키지 않음', () => {
  // 파견 분대장이 ```md 블록으로 인용 헤더를 돌려보냈는데 펜스가 실수로 안 닫힌 채 파일 끝에 도달한
  // 실제 시나리오. 재적재 가드/미응답 판정 소비처에서 이걸 "이미 대응함"으로 읽으면 안 된다.
  const text = [
    '```md',
    '## 커밋 abc123 대응 — 인용된 예시, 펜스가 실수로 안 닫힘',
  ].join('\n');
  let fellBack = false;
  const ids = respondedIds(text, () => { fellBack = true; });
  assert.equal(fellBack, true); // 사실 자체는 반드시 관측 가능해야 한다
  assert.equal(ids.has('abc123'), false); // 그러나 인용 헤더가 진짜 대응으로 승격되면 안 된다
});

test('High-1: respondedIds 폴백 금지 상태에서도, 펜스 밖의 진짜 헤더는 정상 인식한다', () => {
  const text = [
    '```md',
    '## 커밋 abc123 대응 — 인용, 펜스 안 닫힘',
  ].join('\n');
  // 펜스가 열린 상태로 파일이 끝나므로 그 뒤에 진짜 헤더가 올 수는 없지만(같은 파일 append-only),
  // 별도 스캔에서 펜스 밖 헤더가 여전히 정상 인식되는지(폴백 금지가 펜스 인식 자체를 해치지 않는지)
  // 확인한다.
  const clean = '## 커밋 def456 대응 — 펜스 없는 정상 헤더';
  const ids = respondedIds(clean);
  assert.equal(ids.has('def456'), true);
  const idsQuoted = respondedIds(text, () => {});
  assert.equal(idsQuoted.has('abc123'), false);
});

test('High-1: scanSafe는 기본값(allowFallback 미지정)이면 여전히 폴백한다 — Stop 훅 스탬프 경로 보존', () => {
  const lines = [
    '```md',
    '## 커밋 abc123 대응 — 펜스가 끝까지 안 닫힘',
  ];
  let fellBack = false;
  const safe = scanSafe(lines, () => { fellBack = true; });
  assert.equal(fellBack, true);
  assert.equal(safe.indices.length, 1); // 기본값 true라 여전히 비인식 폴백 → 헤더가 잡힌다
});

test('High-1: scanSafe에 allowFallback:false를 명시하면 폴백하지 않는다', () => {
  const lines = [
    '```md',
    '## 커밋 abc123 대응 — 펜스가 끝까지 안 닫힘',
  ];
  let fellBack = false;
  const safe = scanSafe(lines, () => { fellBack = true; }, { allowFallback: false });
  assert.equal(fellBack, true); // 콜백은 여전히 호출된다
  assert.equal(safe.indices.length, 0); // 폴백 안 하므로 펜스 안이라 인식 안 됨
});
