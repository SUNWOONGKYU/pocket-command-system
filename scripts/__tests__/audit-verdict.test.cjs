// audit-verdict.cjs 회귀 테스트 — needsAction/severityOf.
//   실제로 [경미] 안에 진짜 결함(2026-07-25 클램프 누락)이 섞였던 사고를 계기로
//   '심각도'가 아니라 '조치 필요 여부' 표식을 직접 읽게 바뀐 로직이다. 이 판정이
//   틀리면 감사 게이트가 조용히 뚫린다 — fail-safe 방향(불명 시 true)까지 포함해 검증한다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { severityOf, needsAction, needsActionDetail } = require('../audit-verdict.cjs');

test('신형식: [경미] [조치필요] — needsAction true', () => {
  const text = '[경미] [조치필요] — 스캔 예산이 없어 하트비트가 멎을 수 있다.';
  assert.equal(severityOf(text), '경미');
  assert.equal(needsAction(text), true);
});

test('신형식: [주의] [조치불요] — needsAction false (심각해 보여도 명시 표식을 따른다)', () => {
  const text = '[주의] [조치불요] — 위험하지만 이번 커밋 책임이 아니고 별건으로 추적 중.';
  assert.equal(severityOf(text), '주의');
  assert.equal(needsAction(text), false);
});

test('붙여쓰기 변형: [경미][조치필요] (공백 없음) 도 인식한다', () => {
  const text = '[경미][조치필요] — 공백 없이 붙여 쓴 경우.';
  assert.equal(needsAction(text), true);
});

test('구형식(조치 표식 없음): [경미] 만 있으면 심각도 폴백으로 false', () => {
  // ★실사고 재현: [경미] 안에 진짜 결함이 섞여도, 조치 표식이 없는 구형식에서는
  //   심각도만으로 조치 필요 여부를 정한다 — [경미]/[정상]은 불필요로 폴백.
  const text = '[경미] 사소해 보이지만 실은 클램프가 누락돼 새 대응이 영구 누락된다.';
  assert.equal(severityOf(text), '경미');
  assert.equal(needsAction(text), false);
});

test('구형식: [주의] 만 있으면 심각도 폴백으로 true', () => {
  const text = '[주의] 조치 표식 없이 옛 규격으로 남긴 의견.';
  assert.equal(needsAction(text), true);
});

test('구형식: [중대] 만 있으면 심각도 폴백으로 true', () => {
  const text = '[중대] 조치 표식 없이 옛 규격으로 남긴 의견.';
  assert.equal(needsAction(text), true);
});

test('판정 없음(빈 문자열): fail-safe로 true, severityOf는 null', () => {
  assert.equal(severityOf(''), null);
  assert.equal(needsAction(''), true);
});

test('판정 없음(무관한 텍스트): fail-safe로 true', () => {
  const text = '이건 그냥 아무 설명이고 판정 마커가 전혀 없다.';
  assert.equal(needsAction(text), true);
});

test('본문 인용에 속지 않기: 진짜 판정이 문서 맨 앞이 아니면 무시한다', () => {
  // SEVERITY_RE/ACTION_RE는 앵커(^\s*)로 "문서의 진짜 시작"만 본다.
  // 판정 마커가 문장 중간에 인용으로만 등장하면(문서 시작이 아니면) 읽지 않는다.
  const text = 'PO 코멘트: "[중대] [조치필요]"를 예전에 인용했을 뿐, 이번 판정은 아래에 있다.';
  assert.equal(severityOf(text), null);
  // 명시 판정도 폴백 심각도도 못 읽으므로 fail-safe로 true.
  assert.equal(needsAction(text), true);
});

test('공백 변형: 선행 개행·공백·복수 공백이 있어도 첫 토큰을 정상 인식', () => {
  const text = '\n\n   [경미]   [조치필요]   — 앞에 개행과 공백이 여러 번 있다.';
  assert.equal(severityOf(text), '경미');
  assert.equal(needsAction(text), true);
});

test('공백 변형: 탭 문자로 시작해도 인식', () => {
  const text = '\t[주의] [조치불요] — 탭으로 시작.';
  assert.equal(severityOf(text), '주의');
  assert.equal(needsAction(text), false);
});

// ★/m 회귀 방지 — 코드 주석(audit-verdict.cjs:13-19)이 명시한 취약 시나리오.
//   인용이 "같은 줄 중간"이 아니라 "자기 줄 전체"를 차지하면, /m 플래그는 그 인용 줄을
//   ^ 앵커의 매치 대상으로 삼아 진짜 판정보다 먼저 오독한다. 기존 '본문 인용에 속지 않기'
//   테스트(55~62행)는 같은 줄 인용만 검증해 이 경로를 못 잡았다 — 이 두 테스트가 그 구멍을 메운다.
test('/m 회귀 방지 ①: 인용이 자기 줄 전체를 차지해도 문서 시작이 아니면 무시한다(severityOf)', () => {
  // 코드 주석의 실제 예시. /m 이 있으면 둘째 줄 '[정상]'이 먼저 매치돼 '정상'으로 오독된다.
  // /m 이 없으면(현재 코드) 문자열 진짜 시작이 '[' 가 아니므로 아예 매치되지 않아야 한다.
  const text = '이전 감사 인용:\n[정상] 이었으나...\n[중대] [조치필요] — 진짜 지적';
  assert.equal(severityOf(text), null);
  assert.equal(needsAction(text), true); // 심각도도 못 읽으므로 fail-safe로 조치필요.
});

test('/m 회귀 방지 ②: 인용 줄의 [조치불요]가 진짜 판정([조치필요])을 가리면 안 된다(needsAction)', () => {
  // 인용 줄 자체가 완전한 '[심각도] [조치불요]' 형식이면, /m 이 있을 때 ACTION_RE가 그 인용 줄에서
  // 먼저 매치해 진짜 판정(둘째 줄 아래의 [조치필요])을 덮어써 조치를 누락시킨다 — fail-safe 반대 방향
  // 오작동이라 가장 위험한 경로다. /m 이 없으면 문서 진짜 시작에서 매치가 실패해 fail-safe(true)여야 한다.
  const text = '이전 감사 인용:\n[경미] [조치불요] — 별건\n[중대] [조치필요] — 진짜 지적';
  assert.equal(needsAction(text), true);
});

// ★외부 검증 지적 High-2(2026-07-27): needsAction의 심각도 폴백은 구형식 감사(수백 건) 호환을
//   위한 것이지만, 감사관이 신규 규격([조치필요]/[조치불요])을 안 지킨 "비규격 출력"에서도 같은
//   구멍이 조용히 열린다 — 예: `[경미] — 실제 결함입니다...`. needsActionDetail은 이 폴백 발동
//   사실을 source로 노출해 호출부가 로그를 남기게 한다. 단순 반전은 금지(구형식 호환 유지).
test('High-2: needsActionDetail — 신형식 마커가 있으면 source는 marker', () => {
  const text = '[경미] [조치필요] — 스캔 예산이 없어 하트비트가 멎을 수 있다.';
  const r = needsActionDetail(text);
  assert.equal(r.action, true);
  assert.equal(r.source, 'marker');
});

test('High-2: needsActionDetail — 마커 없이 심각도만 있으면 source는 severity-fallback (기존 판정값은 유지)', () => {
  // 감사관이 신규 규격을 안 지킨 비규격 출력 재현: "[경미] — 실제 결함입니다..."
  const text = '[경미] — 실제 결함입니다. 클램프 누락으로 새 대응이 영구 누락됩니다.';
  const r = needsActionDetail(text);
  assert.equal(r.action, false); // ★기존 동작 유지 — 여기가 이 회귀 테스트의 핵심 관측점
  assert.equal(r.source, 'severity-fallback'); // 그러나 폴백 발동은 반드시 관측 가능해야 한다
  assert.equal(needsAction(text), r.action); // 기존 API(boolean)는 그대로 호환
});

test('High-2: needsActionDetail — 심각도도 못 읽으면 source는 fail-safe, action은 true', () => {
  const r = needsActionDetail('아무 판정 마커도 없는 텍스트.');
  assert.equal(r.action, true);
  assert.equal(r.source, 'fail-safe');
});

test('High-2: needsActionDetail — [주의]/[중대] 심각도 폴백도 source는 severity-fallback', () => {
  const r1 = needsActionDetail('[주의] 조치 표식 없이 옛 규격으로 남긴 의견.');
  assert.equal(r1.action, true);
  assert.equal(r1.source, 'severity-fallback');
  const r2 = needsActionDetail('[중대] 조치 표식 없이 옛 규격으로 남긴 의견.');
  assert.equal(r2.action, true);
  assert.equal(r2.source, 'severity-fallback');
});
