#!/usr/bin/env node
/**
 * response-actor-stamp.js — 감사 '대응' 주체(데몬 vs 소대장) 결정적 스탬프 (Stop 훅)
 *
 * 배경: 감사 대응(_audit/대응이력.md append)을 누가 했는지 — 자동 백그라운드 워커(데몬 소대장)인지,
 *   사람이 붙은 대화형 Claude Code 세션(인터랙티브 소대장)인지 — 지금까지는 LLM이 헤더에 '[데몬]'/
 *   '[소대장]'을 손으로 적도록 지시(session-audit-check.js·agent-runner respPrompt)만 했다. 실제
 *   대응이력.md를 보면 '(에코)', '(대화형 소대장 세션)', 태그 없음 등 제각각이라 구분이 불가능했다.
 *
 * 이 훅은 대응이 파일에 append된 뒤(턴 종료 = Stop) 실행자를 '코드로' 판정해, 이번 턴에 새로 추가된
 *   대응 헤더 줄 끝에 기계 판독 마커를 결정적으로 찍는다:
 *     - 워커 데몬이 띄운 claude 하위 세션 → 환경변수 PCSS_ACTOR(=워커명) 존재 → '[actor:daemon:<워커명>]'
 *     - 대화형 Claude Code 세션(사람) → PCSS_ACTOR 없음 → '[actor:leader]'
 *   (enqueue-audit.js가 '커밋 주체'를 PCSS_ACTOR로 판정하는 것과 동일한 신호를 '대응 주체'에 적용.)
 *
 * 원칙:
 *   - 항상 exit 0 — 훅 실패가 세션/턴을 막으면 안 된다. 모든 오류는 조용히 삼킨다. 절대 블록하지 않는다.
 *   - _audit/대응이력.md가 없는 repo의 세션은 즉시 no-op(비관련 폴더 오버헤드 0).
 *   - 비파괴·멱등: 헤더 줄 끝에 마커를 '추가'만 한다. 이미 '[actor:'가 있는 줄·과거 이력은 건드리지 않는다.
 *   - high-water-mark(_audit/.response-actor-state.json, _audit는 gitignore)로 '이번에 새로 생긴' 헤더만
 *     스탬프한다 → 설치 시점의 기존 이력은 legacy로 남기고(주체 불명), 이후 대응만 정확히 표식.
 */
const fs = require('fs');
const path = require('path');

// 대응 헤더: '## 커밋 <hash|t-id> ... 대응 ...' (재수신/3차 수신 등 변종 포함). 커밋 파이프라인·용병 산출물(t-) 공통.
const HEADER_RE = /^## 커밋 (?:t-)?[0-9a-f]{6,40}\b.*대응/;

function findAuditDir(startCwd) {
  // cwd에서 위로 걸어 올라가며 _audit/대응이력.md를 가진 repo 루트를 찾는다(최대 12단계).
  let dir = path.resolve(startCwd || process.cwd());
  for (let i = 0; i < 12; i++) {
    const respFile = path.join(dir, '_audit', '대응이력.md');
    if (fs.existsSync(respFile)) return { auditDir: path.join(dir, '_audit'), respFile };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

try {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { /* stdin 없이 수동 실행 등 */ }
  const found = findAuditDir(input.cwd || process.cwd());
  if (!found) process.exit(0); // 감사 대응 대상 repo 아님 — 조용히 종료
  const { auditDir, respFile } = found;
  const statePath = path.join(auditDir, '.response-actor-state.json');

  const mtimeMs = fs.statSync(respFile).mtimeMs;
  let state = null;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* 첫 실행 */ }

  // 파일이 우리가 마지막으로 처리한 뒤로 안 바뀌었으면 대용량 파일 재파싱 없이 즉시 종료.
  if (state && state.mtimeMs === mtimeMs) process.exit(0);

  const text = fs.readFileSync(respFile, 'utf8');
  const lines = text.split('\n'); // CRLF는 각 줄 끝 '\r'로 보존됨 — join('\n')으로 원본 EOL 그대로 복원.
  const headerIdx = [];
  for (let i = 0; i < lines.length; i++) if (HEADER_RE.test(lines[i])) headerIdx.push(i);
  const currentCount = headerIdx.length;

  // 첫 실행: 기존 이력을 baseline으로 기록만 하고 스탬프하지 않는다(과거 주체 오표식 방지).
  if (!state || typeof state.stampedThrough !== 'number') {
    fs.writeFileSync(statePath, JSON.stringify({ stampedThrough: currentCount, mtimeMs }));
    process.exit(0);
  }

  const actor = (process.env.PCSS_ACTOR || process.env.PCS_ACTOR || '').trim();
  const stamp = actor ? `[actor:daemon:${actor}]` : '[actor:leader]';

  let changed = false;
  for (let rank = state.stampedThrough; rank < currentCount; rank++) {
    const li = headerIdx[rank];
    if (li == null) continue;
    let line = lines[li];
    if (line.includes('[actor:')) continue; // 멱등 — 이미 표식된 줄은 건드리지 않음
    const cr = line.endsWith('\r') ? '\r' : '';
    if (cr) line = line.slice(0, -1);
    lines[li] = line + ' ' + stamp + cr;
    changed = true;
  }

  if (changed) fs.writeFileSync(respFile, lines.join('\n'));
  // 쓰기 뒤 최신 mtime을 저장해야 다음 턴 bail-check가 맞는다.
  const newMtime = fs.statSync(respFile).mtimeMs;
  fs.writeFileSync(statePath, JSON.stringify({ stampedThrough: currentCount, mtimeMs: newMtime }));
} catch (e) {
  // 스탬프 실패는 조용히 무시 — 턴 종료 방해 금지
}
process.exit(0);
