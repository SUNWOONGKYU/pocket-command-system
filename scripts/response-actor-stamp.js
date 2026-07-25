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
const crypto = require('crypto');

// .env.local에서 키 읽기 — 대응한 repo 우선, 없으면 pocket-commander 고정 경로 폴백(공유 Supabase 자격).
function envGet(k) {
  for (const p of [path.join(REPO_ROOT || '.', '.env.local'), 'C:/Dev/pocket-commander/.env.local']) {
    try { const t = fs.readFileSync(p, 'utf8'); const m = t.match(new RegExp('^' + k + '=(.*)$', 'm')); if (m) return m[1].trim(); } catch { /* 다음 후보 */ }
  }
  return null;
}
let REPO_ROOT = null;

// 대화형(leader) 대응을 DB events + PO 텔레그램으로 흘려보낸다. 데몬 대응은 이미 DB 태스크로 뜨므로 제외.
//   콕핏 인박스가 events(event_type='audit_response')를 구독해 표시하고, 텔레그램은 능동 알림.
//   전부 best-effort — 실패해도 절대 턴을 막지 않는다(fire-and-forget, exit는 상위에서 0).
// Stop 훅은 턴 종료를 붙잡는다. 상대가 응답 없이 매달리면(블랙홀) "절대 턴을 막지 않는다"는 위 약속이
//   깨지므로, 형제 훅 platoon-session-hook.js 와 동일하게 3초 AbortController 로 끊는다(감사 06afab9c ⓐ).
//   대응이 여러 건이면 순차 await 라 지연이 누적되던 것도 이 상한으로 묶인다.
const FETCH_TIMEOUT_MS = 3000;
async function fetchWithTimeout(input, init) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(input, { ...init, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

async function notifyLeaderResponse(repoName, headerLine, bodyLine) {
  const url = envGet('NEXT_PUBLIC_SUPABASE_URL') || envGet('SUPABASE_URL');
  const key = envGet('SUPABASE_SERVICE_ROLE_KEY');
  const commit = (headerLine.match(/커밋 ((?:t-)?[0-9a-f]{6,40})/) || [])[1] || '?';
  const at = (headerLine.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/) || [])[1] || null;
  const idem = 'aresp:' + repoName + ':' + crypto.createHash('sha256').update(headerLine).digest('hex').slice(0, 16);
  // 1) DB events insert (idempotency_key로 중복 방지 — 같은 대응 헤더 재실행돼도 1건)
  //    ★payload는 메타만 담는다(감사 06afab9c ⓑ). events는 RLS select using(true) 공개읽기라,
  //      대응 헤더·본문 발췌를 실으면 대응문 내용(경로·인명·내부 사정)이 anon 키로 읽힌다.
  //      콕핏 인박스는 repo·commit 으로 표시·딥링크하고, 상세는 _audit/대응이력.md 에서 본다.
  if (url && key) {
    try {
      await fetchWithTimeout(url + '/rest/v1/events', {
        method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify({ event_type: 'audit_response', actor: 'leader', idempotency_key: idem, payload: { repo: repoName, commit, mode: 'leader', at } }),
      });
    } catch { /* 무시 */ }
  }
  // 2) PO 텔레그램 알림(평문 — HTML 파싱 이슈 회피)
  //    텔레그램은 PO 전용 채널이라 본문 발췌를 유지한다(공개읽기 대상이 아니다).
  const token = envGet('TELEGRAM_BOT_TOKEN');
  const chat = envGet('TELEGRAM_ALERT_CHAT_ID');
  if (token && chat) {
    try {
      await fetchWithTimeout('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: '📝 감사 대응 완료 (대화형 소대장 세션) — ' + repoName + ' 커밋 ' + commit + '\n' + (bodyLine || '').slice(0, 300) }),
      });
    } catch { /* 무시 */ }
  }
}

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

(async () => {
try {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { /* stdin 없이 수동 실행 등 */ }
  const found = findAuditDir(input.cwd || process.cwd());
  if (!found) return; // 감사 대응 대상 repo 아님 — 조용히 종료
  const { auditDir, respFile } = found;
  REPO_ROOT = path.dirname(auditDir);
  const repoName = path.basename(REPO_ROOT);
  const statePath = path.join(auditDir, '.response-actor-state.json');

  const mtimeMs = fs.statSync(respFile).mtimeMs;
  let state = null;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* 첫 실행 */ }

  // 파일이 우리가 마지막으로 처리한 뒤로 안 바뀌었으면 대용량 파일 재파싱 없이 즉시 종료.
  if (state && state.mtimeMs === mtimeMs) return;

  const text = fs.readFileSync(respFile, 'utf8');
  const lines = text.split('\n'); // CRLF는 각 줄 끝 '\r'로 보존됨 — join('\n')으로 원본 EOL 그대로 복원.
  const headerIdx = [];
  for (let i = 0; i < lines.length; i++) if (HEADER_RE.test(lines[i])) headerIdx.push(i);
  const currentCount = headerIdx.length;

  // 첫 실행: 기존 이력을 baseline으로 기록만 하고 스탬프하지 않는다(과거 주체 오표식 방지).
  if (!state || typeof state.stampedThrough !== 'number') {
    fs.writeFileSync(statePath, JSON.stringify({ stampedThrough: currentCount, mtimeMs }));
    return;
  }

  const actor = (process.env.PCSS_ACTOR || '').trim();
  const isLeader = !actor; // PCSS_ACTOR 없음 = 대화형(leader) 세션
  const stamp = actor ? `[actor:daemon:${actor}]` : '[actor:leader]';

  let changed = false;
  const newLeaderResponses = []; // 이번 턴 새로 생긴 leader 대응 → DB events + 텔레그램 대상
  for (let rank = state.stampedThrough; rank < currentCount; rank++) {
    const li = headerIdx[rank];
    if (li == null) continue;
    let line = lines[li];
    if (line.includes('[actor:')) continue; // 멱등 — 이미 표식된 줄은 건드리지 않음
    const cr = line.endsWith('\r') ? '\r' : '';
    if (cr) line = line.slice(0, -1);
    lines[li] = line + ' ' + stamp + cr;
    changed = true;
    // leader(대화형) 대응만 통지 — 데몬 대응은 이미 DB 태스크로 콕핏·텔레그램에 뜬다.
    if (isLeader) {
      let body = '';
      for (let j = li + 1; j < lines.length && j < li + 6; j++) { const s = lines[j].replace(/\r$/, '').trim(); if (s) { body = s; break; } }
      newLeaderResponses.push({ header: line.replace(/\r$/, ''), body });
    }
  }

  if (changed) fs.writeFileSync(respFile, lines.join('\n'));
  // 쓰기 뒤 최신 mtime을 저장해야 다음 턴 bail-check가 맞는다.
  const newMtime = fs.statSync(respFile).mtimeMs;
  fs.writeFileSync(statePath, JSON.stringify({ stampedThrough: currentCount, mtimeMs: newMtime }));

  // ── 대화형 대응 → DB events + PO 텔레그램 (best-effort, 순차) ──
  for (const r of newLeaderResponses) {
    await notifyLeaderResponse(repoName, r.header, r.body);
  }
} catch (e) {
  // 스탬프/통지 실패는 조용히 무시 — 턴 종료 방해 금지
}
process.exit(0);
})();
