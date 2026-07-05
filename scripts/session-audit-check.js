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

function verdictOf(text, hash) {
  const idx = text.indexOf(`커밋 ${hash}`);
  if (idx < 0) return '';
  const chunk = text.slice(idx, idx + 400);
  const m = chunk.match(/\[(정상|경미|주의|중대)\]/);
  return m ? m[1] : '';
}

try {
  const repoDir = __dirname.endsWith(path.join('scripts')) ? path.join(__dirname, '..') : process.cwd();
  const auditFile = path.join(repoDir, '_audit', '감사이력.md');
  const respFile = path.join(repoDir, '_audit', '대응이력.md');
  if (!fs.existsSync(auditFile)) process.exit(0);

  const auditText = fs.readFileSync(auditFile, 'utf8');
  const respText = fs.existsSync(respFile) ? fs.readFileSync(respFile, 'utf8') : '';

  const audited = extractHashes(auditText, /## 커밋 ([0-9a-f]{6,40}) 감사/g);
  const responded = extractHashes(respText, /## 커밋 ([0-9a-f]{6,40})/g);

  const pending = [...audited].filter((h) => !responded.has(h));
  if (!pending.length) process.exit(0);

  const lines = ['=== 미응답 감사 의견 있음 (pocket-commander _audit/, 자동 주입) ==='];
  for (const h of pending) {
    const v = verdictOf(auditText, h);
    lines.push(`- 커밋 ${h}${v ? ` [${v}]` : ''} — _audit/감사이력.md 에서 상세 확인, 필요시 _audit/대응이력.md 에 입장 기록`);
  }
  lines.push('(감사관이 감사했지만 아직 아무도 응답하지 않은 커밋입니다. 이 세션이 그 작업의 당사자라면 대응하세요.)');
  console.log(lines.join('\n'));
} catch (e) {
  // 주입 실패는 조용히 무시 — 세션 시작 방해 금지
}
process.exit(0);
