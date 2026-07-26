#!/usr/bin/env node
/**
 * session-audit-check.js — pocket-commander 전용 SessionStart 훅
 *
 * 이 repo에서 새 대화형 세션이 시작될 때, _audit/감사이력.md에는 있지만
 * _audit/대응이력.md에는 아직 없는 커밋(=감사관이 감사했지만 아무도 응답하지
 * 않은 건)을 찾아 세션 맨 앞에 주입한다. 텔레그램 알림은 사람(PO) 폰으로만
 * 가고 특정 대화형 세션에 자동 전달할 방법이 없어서, 이 repo를 다시 열 때
 * 자동으로 눈에 띄게 하는 쪽으로 보완한다.
 *
 * 절대 세션 시작을 막지 않는다(항상 exit 0). _audit/ 자체가 없으면 조용히 종료.
 */
const fs = require('fs');
const path = require('path');

function extractHashes(text, headerRe) {
  const set = new Set();
  let m;
  while ((m = headerRe.exec(text))) set.add(m[1]);
  return set;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 그 커밋 감사 항목의 앞부분(첫 줄 판정이 들어 있는 구간)을 잘라 준다.
//   ★줄머리 앵커(^ + /m) 필수 — 앵커 없는 부분문자열 검색(구 버전 lastIndexOf)은, 어느 감사 의견
//   '본문'이 이 마커 문자열을 인용만 해도(예: "이전에 '## 커밋 <해시> 감사 ...' 라고 적었으나") 그
//   인용이 진짜 헤더로 오인돼 verdictOf/needsAction 이 실제 판정 대신 인용문 앞부분을 읽어버린다.
//   extractHashes 는 이미 /^.../gm 로 방어돼 있었는데 chunkOf 만 방어 수준이 낮았다 — 여기서 맞춘다.
//   ★마지막 매치를 쓴다 — 같은 커밋이 재감사·정정되면 항목이 여러 번 나오고, 최종본은 뒤에 있다.
function chunkOf(text, hash) {
  const headerRe = new RegExp('^## 커밋 ' + escapeRegExp(hash) + ' .*$', 'gm');
  let m;
  let last = null;
  while ((m = headerRe.exec(text))) last = m;
  if (!last) return '';
  // 헤더 다음 줄부터가 판정 줄이다 — 헤더 자체를 포함해 넘기면 줄머리 앵커가 헤더에 걸리지 않는다.
  const nl = text.indexOf('\n', last.index);
  return nl < 0 ? '' : text.slice(nl + 1, nl + 1 + 600);
}

function verdictOf(text, hash) {
  return require('./audit-verdict.cjs').severityOf(chunkOf(text, hash)) || '';
}

// 훅으로 직접 실행될 때만 동작한다 — require()로 함수만 가져다 테스트하는 경로(예: chunkOf
//   회귀 테스트)에서는 이 블록이 실행되지 않아야 process.exit(0) 이 테스트 프로세스를 죽이지 않는다.
if (require.main === module) {
  try {
    const repoDir = __dirname.endsWith(path.join('scripts')) ? path.join(__dirname, '..') : process.cwd();
    const auditFile = path.join(repoDir, '_audit', '감사이력.md');
    const respFile = path.join(repoDir, '_audit', '대응이력.md');
    if (!fs.existsSync(auditFile)) process.exit(0);

    const auditText = fs.readFileSync(auditFile, 'utf8');
    const respText = fs.existsSync(respFile) ? fs.readFileSync(respFile, 'utf8') : '';

    // 파견 산출물 감사(t-)도 포함한다 — 자동 대응이 실패하면 사람이 확인해야 하는데 전엔 목록에
    //   아예 오르지 않았다(검토 지적 ⑦).
    // ★줄머리 앵커(^ + /m) 필수 — 앵커 없이 전체 텍스트에서 찾으면, 어느 감사 의견 본문이 다른 감사를
    //   문장 중간에 '## 커밋 <해시> 감사' 식으로 인용만 해도 그 인용이 실제 감사 헤더로 오인돼 존재하지
    //   않거나 이미 끝난 항목이 미응답 목록에 유령으로 낀다(대응이력 헤더 스캐너가 이미 줄머리(^)로만
    //   읽는 것과 같은 방어 — audit-response-scan.cjs HEADER_RE 참고, 여기만 빠져 있었다).
    const audited = extractHashes(auditText, /^## 커밋 ((?:t-)?[0-9a-f]{6,40}) 감사/gm);
    // 대응 존재 판정은 공용 스캐너 — 원문 정규식으로 세면 파견 분대장이 ```md 블록으로 되돌려 보낸
    //   '인용 헤더'가 실제 대응으로 읽혀 미응답이 목록에서 사라진다(검토 지적 ①).
    //   respondedIds는 펜스 미닫힘일 때 폴백하지 않는다(외부 검증 지적 High-1) — 이 SessionStart
    //   주입 맥락에서 그 사실을 식별 가능하게 로그로 남긴다(콜백을 명시 전달).
    const responded = require('./audit-response-scan.cjs').respondedIds(respText, () => {
      console.error('[session-audit-check] 대응이력.md 의 코드펜스가 닫히지 않았다(미응답 판정). 폴백 없이 펜스 인식 결과로 판정한다 — 파일의 펜스 균형을 점검하라.');
    });

    // ★판정 게이트: 꼭 고쳐야 하는 것만 띄운다. 기준은 심각도가 아니라 '조치 필요 여부'다
    //   (PO 결정 2026-07-26) — 심각도와 고쳐야 하는지는 다른 축이고, [경미] 안에 진짜 결함이 섞인다.
    //   해석은 audit-verdict.cjs 단일 출처(구 형식 감사는 심각도로 폴백, 불명이면 띄운다).
    //
    // ★재감사 대응: 커밋당 감사 항목이 여러 개(재감사·정정)일 수 있다.
    //   응답(responded)이 있어도 그 뒤에 재감사가 추가됐으면 최신 감사 판정을 직접 확인한다.
    //   감사 1회 + 응답 1회 = 완결(스킵 안전). 재감사가 추가됐으면 최신 판정으로 재판단.
    const VERDICT = require('./audit-verdict.cjs');
    const auditCountOf = (h) =>
      (auditText.match(new RegExp('^## 커밋 ' + escapeRegExp(h) + ' 감사', 'gm')) || []).length;
    const pending = [...audited]
      .filter((h) => {
        const hasResponse = responded.has(h);
        if (hasResponse && auditCountOf(h) <= 1) return false; // 응답O + 재감사X → 완결, 스킵
        const verdict = VERDICT.needsActionDetail(chunkOf(auditText, h));
        // source가 'marker'가 아니면 감사관 출력이 신규 규격([조치필요]/[조치불요])을 안 지켰다는
        // 뜻이다 — 조용히 넘어가면 재발을 못 알아채므로 로그로 남긴다(외부 검증 지적 High-2, 2026-07-27).
        if (verdict.source !== 'marker') {
          console.error(`[session-audit-check] 커밋 ${h} — 판정 마커 없이 ${verdict.source === 'fail-safe' ? '판정불명 fail-safe' : '심각도 폴백'}으로 게이트 판정(${verdict.action ? '조치필요' : '조치불요'}). 감사관 출력이 신규 규격을 안 지켰다.`);
        }
        return verdict.action;
      });
    if (!pending.length) process.exit(0);

    const lines = ['=== 미응답 감사 의견 있음 (pocket-commander _audit/, 자동 주입) ==='];
    for (const h of pending) {
      const v = verdictOf(auditText, h);
      lines.push(`- 커밋 ${h}${v ? ` [${v}]` : ''} — _audit/감사이력.md 에서 상세 확인, 필요시 _audit/대응이력.md 에 입장 기록`);
    }
    lines.push('(감사관이 감사했지만 아직 아무도 응답하지 않은 커밋입니다. 이 세션이 그 작업의 당사자라면 대응하세요.)');
    // 대응 주체 구분: 이 주입은 인터랙티브 Claude Code 세션(=소대장)에서만 발생한다(데몬은 큐의 '[감사 대응]' 태스크로 처리).
    //   대응 주체(데몬/소대장)의 '기계 판독 마커'는 Stop 훅(scripts/response-actor-stamp.js)이 실행자 환경변수
    //   (PCSS_ACTOR 유무)로 판정해 헤더 끝에 자동으로 찍는다 → 손으로 태그를 적을 필요 없다(적어도 무해).
    lines.push("[대응 기록 규칙] _audit/대응이력.md 에 append할 때 헤더는 '## 커밋 <해시> 대응 — <YYYY-MM-DD HH:MM> (<네 이름>)' 형식으로 써라. 대응 주체 마커('[actor:leader]'=소대장 / '[actor:daemon:<워커>]'=데몬)는 턴 종료 시 Stop 훅이 자동으로 헤더 끝에 붙인다 — 네가 직접 '[소대장]' 같은 태그를 넣지 않아도 데몬 자동대응과 구분된다.");
    console.log(lines.join('\n'));
  } catch (e) {
    // 주입 실패는 조용히 무시 — 세션 시작 방해 금지
  }
  process.exit(0);
}

module.exports = { extractHashes, chunkOf, verdictOf };
