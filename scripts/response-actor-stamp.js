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
//   깨지므로 3초 AbortController 로 끊는다(감사 06afab9c ⓐ).
//   ★단 3초는 fetch '1회당'이다 — 대응이 여러 건이면 순차 await 라 3초 × (건수 × 2) 로 누적돼
//   훅 전역 타임아웃(10초)을 넘길 수 있다(검토 지적 ⑥). 그래서 훅 전체에도 데드라인을 둔다:
//   남은 예산이 없으면 이후 통지는 그냥 건너뛴다(통지는 부가 기능 — 턴을 붙잡는 것보다 낫다).
const FETCH_TIMEOUT_MS = 3000;
const NOTIFY_DEADLINE_MS = 6000; // 훅 전역 타임아웃(10초) 안쪽으로 여유를 남긴다
let notifyDeadlineAt = Infinity;
const budgetLeft = () => notifyDeadlineAt - Date.now();

async function fetchWithTimeout(input, init) {
  const left = budgetLeft();
  if (left <= 0) throw new Error('notify deadline exceeded');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(FETCH_TIMEOUT_MS, left));
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

// 대응 헤더 스캐너는 단일 출처를 쓴다 — 재적재 가드(worker/agent-runner.ts)·SessionStart 주입
//   (session-audit-check.js)과 같은 규칙(코드펜스 인용 제외)이어야 한 쪽만 인용 헤더를 세는 어긋남이 없다.
const RESP_SCAN = require('./audit-response-scan.cjs');

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
  // 코드펜스(``` … ```) 안의 헤더는 '인용'이지 실제 대응 항목이 아니다.
  //   파견 분대장이 샌드박스 때문에 직접 append 하지 못하면 "이렇게 기록할 것이다"라며 대응문을
  //   ```md 블록으로 되돌려 보내고, 러너가 그 본문을 그대로 append 한다. 그러면 인용된 헤더 줄이
  //   파일에 남아 이 훅이 실제 대응으로 오인하고 스탬프 + DB events + 텔레그램까지 발화했다
  //   (실측: t-f11a00a0·t-503fa463·t-659ac674 각 1건씩 유령 대응이 생성됨).
  //   파견 대응 프롬프트에서 헤더 작성을 금지했지만, 다른 벤더·다른 문구로 재발할 수 있으므로
  //   파싱 단계에서도 막는다. 펜스는 ``` 또는 ~~~ 로 시작하는 줄로 토글한다.
  // 헤더 스캔은 공용 스캐너(코드펜스 인용 제외 + 미닫힘 폴백)를 쓴다 — 재적재 가드·SessionStart 주입과
  //   같은 규칙이어야 한 쪽만 인용 헤더를 세는 어긋남이 생기지 않는다(검토 지적 ①).
  const headerIdx = RESP_SCAN.scanSafe(lines, () => {
    console.error('[response-actor-stamp] 대응이력.md 의 코드펜스가 닫히지 않았다 — 이번 실행은 펜스 비인식으로 폴백(인용 헤더가 섞일 수 있음). 파일의 펜스 균형을 점검하라.');
  }).indices;

  // ★상태는 '헤더 개수'가 아니라 '처리한 줄 수(워터마크)'로 둔다(검토 지적 ②).
  //   개수 기준이면 파싱 규칙이 바뀔 때 총수가 흔들려, 새 대응이 이미 처리된 것으로 오인돼 조용히
  //   누락된다(예: 구파싱 146 → 신파싱 143이면 그 사이 새 대응이 루프에 들어오지 못함).
  //   대응이력.md는 append-only 이므로 줄 수는 단조 증가하고 파싱 규칙과 무관하다 — 그 아래는 과거분,
  //   그 위는 이번에 새로 붙은 분으로 항상 정확히 갈린다.
  //   (구 상태 파일은 stampedThrough 만 갖는다 → 워터마크가 없으면 지금 줄 수를 baseline 으로 삼는다.
  //    한 번은 그 시점 이전 미처리분을 건너뛰지만, 과거분을 잘못된 주체로 표식하는 것보다 안전하다.)
  const totalLines = lines.length;
  if (!state || typeof state.stampedThroughLine !== 'number') {
    fs.writeFileSync(statePath, JSON.stringify({ stampedThroughLine: totalLines, mtimeMs }));
    return;
  }

  const actor = (process.env.PCSS_ACTOR || '').trim();
  const isLeader = !actor; // PCSS_ACTOR 없음 = 대화형(leader) 세션
  const stamp = actor ? `[actor:daemon:${actor}]` : '[actor:leader]';

  let changed = false;
  const newLeaderResponses = []; // 이번 턴 새로 생긴 leader 대응 → DB events + 텔레그램 대상
  // 워터마크 위(=이번에 새로 append된 구간)의 헤더만 대상. 그 아래는 과거분이라 건드리지 않는다.
  for (const li of headerIdx) {
    if (li < state.stampedThroughLine) continue;
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
  fs.writeFileSync(statePath, JSON.stringify({ stampedThroughLine: totalLines, mtimeMs: newMtime }));

  // ── 대화형 대응 → DB events + PO 텔레그램 (best-effort, 순차) ──
  //   훅 전체 데드라인 안에서만 돈다 — 예산이 끝나면 남은 통지는 건너뛴다(턴을 붙잡지 않는다).
  notifyDeadlineAt = Date.now() + NOTIFY_DEADLINE_MS;
  for (const r of newLeaderResponses) {
    if (budgetLeft() <= 0) { console.error(`[response-actor-stamp] 통지 예산(${NOTIFY_DEADLINE_MS}ms) 소진 — 남은 ${newLeaderResponses.length - newLeaderResponses.indexOf(r)}건 통지 생략(스탬프는 완료).`); break; }
    await notifyLeaderResponse(repoName, r.header, r.body);
  }
} catch (e) {
  // 스탬프/통지 실패는 조용히 무시 — 턴 종료 방해 금지
}
process.exit(0);
})();
