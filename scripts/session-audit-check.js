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

// 그 커밋 감사 항목의 앞부분(첫 줄 판정이 들어 있는 구간)을 잘라 준다.
//   ★마지막 매치를 쓴다 — 같은 커밋이 재감사·정정되면 항목이 여러 번 나오고, 최종본은 뒤에 있다.
function chunkOf(text, hash) {
  const marker = `## 커밋 ${hash} `;
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return '';
  // 헤더 다음 줄부터가 판정 줄이다 — 헤더 자체를 포함해 넘기면 줄머리 앵커가 헤더에 걸리지 않는다.
  const nl = text.indexOf('\n', idx);
  return nl < 0 ? '' : text.slice(nl + 1, nl + 1 + 600);
}

function verdictOf(text, hash) {
  return require('./audit-verdict.cjs').severityOf(chunkOf(text, hash)) || '';
}

try {
  const repoDir = __dirname.endsWith(path.join('scripts')) ? path.join(__dirname, '..') : process.cwd();
  const auditFile = path.join(repoDir, '_audit', '감사이력.md');
  const respFile = path.join(repoDir, '_audit', '대응이력.md');
  if (!fs.existsSync(auditFile)) process.exit(0);

  const auditText = fs.readFileSync(auditFile, 'utf8');
  const respText = fs.existsSync(respFile) ? fs.readFileSync(respFile, 'utf8') : '';

  // 파견 산출물 감사(t-)도 포함한다 — 자동 대응이 실패하면 사람이 확인해야 하는데 전엔 목록에
  //   아예 오르지 않았다(검토 지적 ⑦).
  const audited = extractHashes(auditText, /## 커밋 ((?:t-)?[0-9a-f]{6,40}) 감사/g);
  // 대응 존재 판정은 공용 스캐너 — 원문 정규식으로 세면 파견 분대장이 ```md 블록으로 되돌려 보낸
  //   '인용 헤더'가 실제 대응으로 읽혀 미응답이 목록에서 사라진다(검토 지적 ①).
  const responded = require('./audit-response-scan.cjs').respondedIds(respText);

  // ★판정 게이트: 꼭 고쳐야 하는 것만 띄운다. 기준은 심각도가 아니라 '조치 필요 여부'다
  //   (PO 결정 2026-07-26) — 심각도와 고쳐야 하는지는 다른 축이고, [경미] 안에 진짜 결함이 섞인다.
  //   해석은 audit-verdict.cjs 단일 출처(구 형식 감사는 심각도로 폴백, 불명이면 띄운다).
  const VERDICT = require('./audit-verdict.cjs');
  const pending = [...audited]
    .filter((h) => !responded.has(h))
    .filter((h) => VERDICT.needsAction(chunkOf(auditText, h)));
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
