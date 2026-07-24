// 소대 내부 편성 실행(Claude Agent Teams / Codex / Antigravity / Dynamic Workflows) 기록 ingestion.
// ★ 이 API는 관측(기록) 전용이다 — PCSS는 지휘관이 아니므로 여기서 어떤 배정·명령도 내리지 않는다.
//   platoon_runs는 소대장이 이미 내부적으로 실행한 편성을 사후/진행 중 기록하는 창구일 뿐이다.
//
// 인증: 헤더 X-PCSS-INGEST-KEY == env PCSS_INGEST_KEY. env 미설정이면 공개 배포에서 무인증 쓰기를
//   막기 위해 항상 401(고정 거부) — "키를 안 걸면 열어준다"가 아니라 "안 걸면 무조건 닫는다".

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export const runtime = 'nodejs';

type AdminClient = ReturnType<typeof createAdminClient>;

const FORMATION_TYPES = ['claude_agent_teams', 'codex', 'antigravity', 'dynamic_workflows'] as const;
type FormationType = typeof FORMATION_TYPES[number];

const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
type RunStatus = typeof RUN_STATUSES[number];

const COUNTER_FIELDS = [
  'claude_teammates',
  'codex_calls',
  'antigravity_calls',
  'dynamic_workflow_runs',
  'peak_parallelism',
] as const;

function checkAuth(req: Request): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.PCSS_INGEST_KEY;
  if (!expected) return { ok: false, status: 401, error: 'PCSS_INGEST_KEY 미설정 — 공개 배포 보호를 위해 항상 거부' };
  const got = req.headers.get('x-pcss-ingest-key');
  if (got !== expected) return { ok: false, status: 401, error: '인증 실패' };
  return { ok: true };
}

function textField(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function resolvePlatoonId(sb: AdminClient, body: Record<string, unknown>): Promise<{ ok: true; platoonId: string } | { ok: false; status: number; error: string }> {
  const explicitPlatoon = textField(body.platoon_id);
  if (explicitPlatoon) return { ok: true, platoonId: explicitPlatoon };

  const workerName = textField(body.worker_name);
  if (!workerName) return { ok: false, status: 400, error: 'platoon_id 또는 worker_name 필요' };

  const { data: agent, error: aErr } = await sb
    .from('agents')
    .select('id')
    .eq('name', workerName)
    .maybeSingle();
  if (aErr) return { ok: false, status: 500, error: 'worker 조회 실패: ' + aErr.message };
  if (!agent?.id) return { ok: false, status: 404, error: '없는 worker_name: ' + workerName };

  const { data: platoon, error: pErr } = await sb
    .from('platoons')
    .select('id')
    .eq('leader_worker_id', agent.id)
    .maybeSingle();
  if (pErr) return { ok: false, status: 500, error: 'platoon 조회 실패: ' + pErr.message };
  if (!platoon?.id) return { ok: false, status: 404, error: 'worker_name에 연결된 platoon 없음: ' + workerName };

  return { ok: true, platoonId: platoon.id };
}

export async function POST(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const sb = createAdminClient();

  const runId = textField(body.run_id);
  const status = textField(body.status) as RunStatus | null;
  if (status && !RUN_STATUSES.includes(status)) {
    return NextResponse.json({ ok: false, error: 'status는 ' + RUN_STATUSES.join('/') + ' 중 하나' }, { status: 400 });
  }

  const counters: Record<string, number> = {};
  if (body.counters && typeof body.counters === 'object') {
    for (const f of COUNTER_FIELDS) {
      const v = (body.counters as Record<string, unknown>)[f];
      if (typeof v === 'number' && Number.isFinite(v)) counters[f] = v;
    }
  }

  // ── 갱신: run_id가 있으면 기존 row를 update ──
  if (runId) {
    const patch: Record<string, unknown> = { ...counters };
    if (status) patch.status = status;
    if (status && status !== 'running') patch.completed_at = new Date().toISOString();
    const taskId = textField(body.task_id);
    if (taskId) patch.task_id = taskId;

    const { data, error } = await sb.from('platoon_runs').update(patch).eq('id', runId).select().maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ ok: false, error: '없는 run_id: ' + runId }, { status: 404 });
    return NextResponse.json({ ok: true, run: data });
  }

  // ── 신규 insert ──
  const formationType = textField(body.formation_type) as FormationType | null;
  if (!formationType || !FORMATION_TYPES.includes(formationType)) {
    return NextResponse.json({ ok: false, error: 'formation_type은 ' + FORMATION_TYPES.join('/') + ' 중 하나' }, { status: 400 });
  }

  const resolved = await resolvePlatoonId(sb, body);
  if (!resolved.ok) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });

  const taskId = textField(body.task_id);
  const insertPayload: Record<string, unknown> = {
    platoon_id: resolved.platoonId,
    formation_type: formationType,
    status: status || 'running',
    ...counters,
    ...(taskId ? { task_id: taskId } : {}),
  };

  const { data, error } = await sb.from('platoon_runs').insert(insertPayload).select().single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, run: data });
}

// ── 조회: platoon_id 쿼리로 최근 run 목록 ──
// anon RLS로도 읽을 수 있는 데이터이지만, 콕핏 외부(로컬 스크립트·어댑터)에서 service_role 없이
// 조회할 창구가 필요할 수 있어 GET도 같은 인증 게이트로 제공한다.
export async function GET(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(req.url);
  const platoonId = textField(searchParams.get('platoon_id'));
  if (!platoonId) return NextResponse.json({ ok: false, error: 'platoon_id 쿼리 필요' }, { status: 400 });

  const limit = Math.min(Number(searchParams.get('limit')) || 20, 100);

  const sb = createAdminClient();
  const { data, error } = await sb
    .from('platoon_runs')
    .select('*')
    .eq('platoon_id', platoonId)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, runs: data });
}
