// 감사 경로 규칙 단일 출처(SSOT).
//   전에는 같은 규칙이 audit-integrity-check.js·enqueue-audit.js·worker/agent-runner.ts 세 곳에
//   복제돼 있었고, 주석으로 "한쪽만 바꾸면 안 된다"고 경고할 뿐이었다(감사 0c404686 관찰 ⓑ).
//   규칙이 어긋나면 원본과 해시 체인이 갈라져 무결성이 조용히 무의미해지므로 한 곳으로 모은다.
//
// ★감사관 전용 폴더 분리(PO 지시 2026-07-25): vault(원본)는 작업자 저장소 "밖"에 둔다.
//   <repo의 부모>/_audit_vault/<repo 이름>/   예) C:/Dev/pocket-commander → C:/Dev/_audit_vault/pocket-commander
//   저장소 밖이라 gitignore와 무관하게 커밋 대상이 아니고, 작업자가 자기 저장소만 다뤄서는 원본에 닿지 않는다.
//   사본(감사이력.md)·대응이력.md는 <repo>/_audit/ 에 남는다 — 작업자가 읽고 대응하는 곳.
const path = require('path');

// 감사관 전용 원본 보관소(저장소 밖).
function vaultDirFor(repoRoot) {
  const abs = path.resolve(repoRoot);
  return path.join(path.dirname(abs), '_audit_vault', path.basename(abs));
}

// 작업자가 읽는 사본·대응 폴더(저장소 안).
function auditDirFor(repoRoot) {
  return path.join(path.resolve(repoRoot), '_audit');
}

// 프롬프트에 실을 때는 슬래시 표기로 통일한다(Windows 백슬래시가 프롬프트·정규식에서 이스케이프로 읽히는 것 방지).
const posix = (p) => String(p).replace(/\\/g, '/');

module.exports = { vaultDirFor, auditDirFor, posix };
