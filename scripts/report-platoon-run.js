// 로컬 어댑터/훅에서 소대 내부 편성 실행(Claude Agent Teams/Codex/Antigravity/Dynamic Workflows)을
// platoon_runs에 기록하는 CLI 리포터. 로컬은 service_role을 보유하므로 /api/platoon-runs를 거치지 않고
// Supabase REST에 직접 insert/update한다 (enqueue-audit.js의 env 읽기 패턴 재사용).
//
// ★ 이 스크립트는 관측(기록) 전용이다 — PCSS는 지휘관이 아니므로 여기서 어떤 배정·명령도 내리지 않는다.
//
// 사용:
//   node report-platoon-run.js --worker <legacy worker명> --type codex --status running
//     → 신규 run insert, run_id를 stdout에 출력(다음 호출에서 --run-id로 갱신)
//   node report-platoon-run.js --run-id <uuid> --status completed --counters '{"codex_calls":3}'
//     → 기존 run 갱신(completed/failed/cancelled면 completed_at 자동 세팅)
//
// 옵션:
//   --platoon-id <uuid>       platoon 직접 지정(둘 중 하나 필수: --worker 또는 --platoon-id, run 갱신 시 불필요)
//   --worker <name>           legacy worker명 → agents.id → platoons.leader_worker_id 역조회
//   --run-id <uuid>           있으면 갱신, 없으면 신규 insert
//   --type <formation_type>   claude_agent_teams|codex|antigravity|dynamic_workflows (신규 insert 시 필수)
//   --status <status>         running|completed|failed|cancelled
//   --task-id <uuid>          연결할 task (선택)
//   --counters '<json>'       {"claude_teammates":n,"codex_calls":n,"antigravity_calls":n,"dynamic_workflow_runs":n,"peak_parallelism":n}
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env.local');
const FORMATION_TYPES = ['claude_agent_teams', 'codex', 'antigravity', 'dynamic_workflows'];
const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'];
const COUNTER_FIELDS = ['claude_teammates', 'codex_calls', 'antigravity_calls', 'dynamic_workflow_runs', 'peak_parallelism'];

function envGet(k) { try { const t = fs.readFileSync(ENV_PATH, 'utf8'); const m = t.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; } catch { return null; } }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const url = envGet('NEXT_PUBLIC_SUPABASE_URL') || envGet('SUPABASE_URL');
  const key = envGet('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) { console.error('[platoon-run] supabase 자격 없음 — 스킵'); process.exit(1); }

  const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' };

  const status = args.status || null;
  if (status && !RUN_STATUSES.includes(status)) {
    console.error('[platoon-run] status는 ' + RUN_STATUSES.join('/') + ' 중 하나:', status); process.exit(1);
  }

  let counters = {};
  if (args.counters) {
    try {
      const parsed = JSON.parse(args.counters);
      for (const f of COUNTER_FIELDS) if (typeof parsed[f] === 'number') counters[f] = parsed[f];
    } catch (e) { console.error('[platoon-run] --counters JSON 파싱 실패:', String(e)); process.exit(1); }
  }

  // ── 갱신 경로 ──
  if (args['run-id']) {
    const patch = { ...counters };
    if (status) patch.status = status;
    if (status && status !== 'running') patch.completed_at = new Date().toISOString();
    if (args['task-id']) patch.task_id = args['task-id'];

    try {
      const r = await fetch(url + '/rest/v1/platoon_runs?id=eq.' + encodeURIComponent(args['run-id']), {
        method: 'PATCH', headers: H, body: JSON.stringify(patch),
      });
      if (!r.ok) { console.error('[platoon-run] 갱신 실패', r.status, await r.text()); process.exit(1); }
      const j = await r.json();
      console.log('[platoon-run] 갱신:', args['run-id'], '→', status || '(counters only)');
      console.log(JSON.stringify(j[0] || null));
    } catch (e) { console.error('[platoon-run] 네트워크 오류', String(e)); process.exit(1); }
    return;
  }

  // ── 신규 insert 경로 ──
  const formationType = args.type;
  if (!formationType || !FORMATION_TYPES.includes(formationType)) {
    console.error('[platoon-run] --type은 ' + FORMATION_TYPES.join('/') + ' 중 하나 필요'); process.exit(1);
  }

  let platoonId = args['platoon-id'] || null;
  if (!platoonId) {
    if (!args.worker) { console.error('[platoon-run] --platoon-id 또는 --worker 필요'); process.exit(1); }
    try {
      const ra = await fetch(url + '/rest/v1/agents?select=id&name=eq.' + encodeURIComponent(args.worker), { headers: H });
      const ja = await ra.json();
      const agentId = Array.isArray(ja) && ja[0] ? ja[0].id : null;
      if (!agentId) { console.error('[platoon-run] 없는 worker명:', args.worker); process.exit(1); }

      const rp = await fetch(url + '/rest/v1/platoons?select=id&leader_worker_id=eq.' + encodeURIComponent(agentId), { headers: H });
      const jp = await rp.json();
      platoonId = Array.isArray(jp) && jp[0] ? jp[0].id : null;
      if (!platoonId) { console.error('[platoon-run] worker에 연결된 platoon 없음:', args.worker); process.exit(1); }
    } catch (e) { console.error('[platoon-run] platoon 조회 실패', String(e)); process.exit(1); }
  }

  const insertPayload = {
    platoon_id: platoonId,
    formation_type: formationType,
    status: status || 'running',
    ...counters,
    ...(args['task-id'] ? { task_id: args['task-id'] } : {}),
  };

  try {
    const r = await fetch(url + '/rest/v1/platoon_runs', { method: 'POST', headers: H, body: JSON.stringify(insertPayload) });
    if (!r.ok) { console.error('[platoon-run] 적재 실패', r.status, await r.text()); process.exit(1); }
    const j = await r.json();
    const row = j[0] || null;
    console.log('[platoon-run] 적재:', platoonId, formationType, '→ run_id:', row && row.id);
    console.log(JSON.stringify(row));
  } catch (e) { console.error('[platoon-run] 네트워크 오류', String(e)); process.exit(1); }
})();
