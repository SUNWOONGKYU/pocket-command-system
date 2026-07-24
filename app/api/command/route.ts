// PCSS 명령 API — PO가 명시적으로 선택한 소대(platoon) 또는 legacy 워커(agent)에만 태스크를 발행한다.
// PCSS는 자연어를 해석해 담당을 추측하거나 재배정하지 않는다.
// 기존 콕핏 호환을 위해 body.agent는 유지하고, 신규 세션=소대 모델은 body.platoon_id를 우선 지원한다.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export const runtime = 'nodejs';

type AdminClient = ReturnType<typeof createAdminClient>;
type Target = { agentName: string; platoonId: string | null };

// PO 텔레그램 chat_id — env 우선, 없으면 최근 텔레그램 명령에서 자동 추출(enqueue-audit.js와 동일 전략)
async function resolveChatId(sb: AdminClient): Promise<number | null> {
  const env = process.env.TELEGRAM_ALERT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (env) return Number(env);
  const { data } = await sb
    .from('tasks')
    .select('source_chat_id')
    .not('source_chat_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.source_chat_id ?? null;
}

function textField(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function resolveTarget(sb: AdminClient, body: Record<string, unknown>): Promise<{ ok: true; target: Target } | { ok: false; error: string; status: number }> {
  const explicitAgent = textField(body.agent);
  const explicitPlatoon = textField(body.platoon_id) || textField(body.platoon);

  if (!explicitAgent && !explicitPlatoon) {
    return { ok: false, error: 'platoon_id 또는 agent(legacy 대상) 필요', status: 400 };
  }

  if (explicitPlatoon) {
    const { data: p, error: pErr } = await sb
      .from('platoons')
      .select('id, leader_worker_id')
      .eq('id', explicitPlatoon)
      .maybeSingle();
    if (pErr) return { ok: false, error: 'platoon 조회 실패: ' + pErr.message, status: 500 };
    if (!p?.leader_worker_id) return { ok: false, error: '없는 소대 또는 leader_worker_id 미설정: ' + explicitPlatoon, status: 404 };

    const { data: a, error: aErr } = await sb
      .from('agents')
      .select('name, control, status')
      .eq('id', p.leader_worker_id)
      .maybeSingle();
    if (aErr) return { ok: false, error: '소대장 조회 실패: ' + aErr.message, status: 500 };
    if (!a?.name) return { ok: false, error: '소대장 legacy worker 없음: ' + explicitPlatoon, status: 404 };
    if (explicitAgent && explicitAgent !== a.name) {
      return { ok: false, error: `대상 충돌: platoon_id는 ${a.name}에 연결되어 있으나 agent=${explicitAgent}`, status: 400 };
    }
    return { ok: true, target: { agentName: a.name, platoonId: p.id } };
  }

  const { data: a, error } = await sb
    .from('agents')
    .select('name, control, status')
    .eq('name', explicitAgent)
    .maybeSingle();
  if (error) return { ok: false, error: 'agent 조회 실패: ' + error.message, status: 500 };
  if (!a?.name) return { ok: false, error: '없는 legacy 워커: ' + explicitAgent, status: 404 };
  return { ok: true, target: { agentName: a.name, platoonId: null } };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  const sb = createAdminClient();
  const resolved = await resolveTarget(sb, body);
  if (!resolved.ok) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const { agentName, platoonId } = resolved.target;

  // ── 워커/소대장 제어 (급정지/재가동) ──
  if (body.control === 'run' || body.control === 'stop') {
    await sb.from('agents').update({ control: body.control }).eq('name', agentName);
    return NextResponse.json({ ok: true, note: body.control === 'stop' ? '급정지 신호' : '재가동 신호', target: resolved.target });
  }
  // ── 종료: 실행 정지 + 이 워커의 대기·진행 작업을 끝냄(재개 안 됨) ──
  if (body.control === 'terminate') {
    await sb.from('agents').update({ control: 'stop' }).eq('name', agentName);
    await sb.from('tasks').update({ status: 'failed', result: '⛔ 종료됨' })
      .eq('assigned_agent', agentName).in('status', ['queued', 'in_progress']);
    return NextResponse.json({ ok: true, note: '작업 종료', target: resolved.target });
  }

  // ── 새 명령 발행 (PO가 명시 선택한 대상에 태스크 큐잉) ──
  const text = (body.text || '').toString().trim();
  // 첨부 메타 배열(선택) — 있으면 tasks.attachments 에 저장, 없으면 기존과 동일(하위호환).
  //   업로드 API(/api/upload)가 반환한 형태만 통과시킨다(path/name/url 필수). 최대 5개.
  const rawAtt = Array.isArray(body.attachments) ? body.attachments : [];
  const attachments = rawAtt
    .filter((a: unknown): a is Record<string, unknown> => !!a && typeof a === 'object')
    .filter((a: Record<string, unknown>) => typeof a.path === 'string' && typeof a.name === 'string' && typeof a.url === 'string')
    .slice(0, 5)
    .map((a: Record<string, unknown>) => ({
      path: a.path, url: a.url,
      // name은 워커가 파일명으로 쓰므로 여기서도 경로성분 제거(방어심층 — 워커 측이 최종 방어).
      name: (String(a.name).split(/[/\\]/).pop() || 'file').replace(/[^\w.\-가-힣()[\]]/g, '_').slice(0, 120),
      size: typeof a.size === 'number' ? a.size : 0,
      mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream',
    }));
  // 첨부만 있고 텍스트가 없으면 허용(파일만 전송) — 텍스트·첨부 둘 다 없을 때만 거부.
  if (!text && attachments.length === 0) return NextResponse.json({ ok: false, error: '명령 텍스트 필요' }, { status: 400 });

  const chatId = await resolveChatId(sb); // 결과를 텔레그램으로 돌려받기 위해 실는다
  const legacyPayload = {
    command_text: text,
    assigned_agent: agentName,
    status: 'queued',
    source_chat_id: chatId,
    ...(attachments.length > 0 ? { attachments } : {}), // 없으면 컬럼을 아예 안 건드림(하위호환·null 유지)
  };
  const pcssPayload = {
    ...legacyPayload,
    ...(platoonId ? { assigned_platoon_id: platoonId } : {}),
    ordered_by: 'PO',
    task_type: 'po_direct_command',
  };

  let { data, error } = await sb.from('tasks').insert(pcssPayload).select().single();
  // 감사(436a58d5 ⓑ) 반영: 판정을 신규 컬럼명 화이트리스트로 한정 — 무관한 'column' 오류가
  // legacy 재시도로 빠져 assigned_platoon_id를 조용히 누락시키는 것 방지.
  if (error && /assigned_platoon_id|ordered_by|task_type/i.test(error.message)) {
    // schema migration 전 배포 호환: 신규 컬럼이 아직 없으면 legacy payload로 한 번 재시도한다.
    const retry = await sb.from('tasks').insert(legacyPayload).select().single();
    data = retry.data;
    error = retry.error;
  }

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, task: data, target: resolved.target });
}
