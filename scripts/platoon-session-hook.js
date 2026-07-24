// 소대장 모드 전환 훅 — 대화형 Claude Code 세션이 소대(platoon) 작업폴더에서 열리면
// 그 세션을 '인터랙티브 소대장'으로 DB에 표시하고, 닫히면 '데몬 소대장'으로 되돌린다.
//   사용(전역 ~/.claude/settings.json hooks):
//     SessionStart      → node platoon-session-hook.js start
//     UserPromptSubmit  → node platoon-session-hook.js touch   (leader_seen_at 신선도 갱신)
//     SessionEnd        → node platoon-session-hook.js end
//   훅 입력(JSON)은 stdin으로 온다: { session_id, cwd, ... }
//
// 원칙:
//   - 항상 exit 0 — 훅 실패가 세션을 막으면 안 된다. 모든 오류는 조용히 삼킨다.
//   - 워커 데몬이 띄운 claude 하위 세션(PCSS_ACTOR/PCS_ACTOR 보유)은 소대장 세션이 아니다 — 즉시 스킵.
//   - 소대 작업폴더가 아닌 곳의 세션은 no-op. cwd→소대 매칭 결과를 로컬 캐시(10분)해
//     비관련 폴더에서의 프롬프트마다 네트워크를 타지 않는다.
//   - touch는 60초 스로틀 — 프롬프트 연타에도 PATCH 폭주 없음.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env.local');
const CACHE_PATH = path.join(os.tmpdir(), 'pcss-platoon-hook-cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
const TOUCH_THROTTLE_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

function envGet(k) { try { const t = fs.readFileSync(ENV_PATH, 'utf8'); const m = t.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; } catch { return null; } }
function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function readCache() { try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; } }
function writeCache(c) { try { fs.writeFileSync(CACHE_PATH, JSON.stringify(c)); } catch { /* 캐시는 성능용 — 실패 무시 */ } }

async function sbFetch(url, key, pathAndQuery, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url + '/rest/v1/' + pathAndQuery, {
      ...opts,
      signal: ctrl.signal,
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    return r.ok ? await r.json().catch(() => null) : null;
  } finally { clearTimeout(timer); }
}

(async () => {
  try {
    const action = process.argv[2]; // start | touch | end
    if (!['start', 'touch', 'end'].includes(action)) return;
    // 워커 데몬의 하위 claude 세션은 소대장이 아니다(데몬 소대장 본인) — 표시 전환 금지.
    if (process.env.PCSS_ACTOR || process.env.PCS_ACTOR) return;

    let input = {};
    // BOM strip — PowerShell 파이프 등이 U+FEFF를 붙여도 파싱되게(실훅 입력엔 없지만 방어).
    try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { /* stdin 없이 수동 실행 등 */ }
    const cwd = norm(input.cwd || process.cwd());
    const sessionId = input.session_id || null;

    const cache = readCache();
    const hit = cache[cwd];
    const now = Date.now();

    // 캐시된 '소대 아님' 판정이 신선하면 네트워크 없이 종료 — 비관련 폴더 오버헤드 0.
    if (hit && now - (hit.at || 0) < CACHE_TTL_MS && hit.platoonId === null) return;
    // touch 스로틀 — 같은 소대에 60초 내 재touch 생략.
    if (action === 'touch' && hit && hit.platoonId && now - (hit.touchedAt || 0) < TOUCH_THROTTLE_MS) return;

    const url = envGet('NEXT_PUBLIC_SUPABASE_URL') || envGet('SUPABASE_URL');
    const key = envGet('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return;

    let platoonId = hit && now - (hit.at || 0) < CACHE_TTL_MS ? hit.platoonId : undefined;
    if (platoonId === undefined) {
      // cwd가 어느 소대의 작업폴더(또는 그 하위)인지 매칭. 가장 긴 workdir 우선(중첩 대비).
      // 같은 repo를 보는 감사관 소대는 제외 — 대화형 세션의 소대장 자리는 본작업 소대다.
      const rows = (await sbFetch(url, key, 'platoons?select=id,workdir,leader:agents!platoons_leader_worker_id_fkey(name)&workdir=not.is.null')) || [];
      let best = null;
      for (const p of rows) {
        const leaderName = p.leader && p.leader.name ? p.leader.name : '';
        if (leaderName.endsWith('감사관')) continue;
        const w = norm(p.workdir);
        if (w && (cwd === w || cwd.startsWith(w + '/')) && (!best || w.length > norm(best.workdir).length)) best = p;
      }
      platoonId = best ? best.id : null;
      cache[cwd] = { at: now, platoonId, touchedAt: 0 };
      writeCache(cache);
      if (!platoonId) return;
    }

    const nowIso = new Date().toISOString();
    const patch =
      action === 'end'
        ? { leader_mode: 'daemon', leader_seen_at: nowIso }
        : { leader_mode: 'interactive', leader_seen_at: nowIso, ...(sessionId ? { claude_session_id: sessionId } : {}) };
    await sbFetch(url, key, 'platoons?id=eq.' + encodeURIComponent(platoonId), { method: 'PATCH', body: JSON.stringify(patch), headers: { Prefer: 'return=minimal' } });

    cache[cwd] = { at: (cache[cwd] && cache[cwd].at) || now, platoonId, touchedAt: now };
    writeCache(cache);
  } catch { /* 훅은 어떤 경우에도 세션을 막지 않는다 */ }
})();
