// 콕핏 명령 API — 카드 탭 대상에 새 명령(태스크) 발행 + 워커 제어(run/stop).
// 결과는 텔레그램으로 온다 → 명령 발행 시 PO 텔레그램 chat_id를 source_chat_id에 실어야 워커가 결과를 보고한다.
// 브라우저(anon)는 RLS로 읽기만 → 쓰기는 이 라우트(service_role)를 거친다.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export const runtime = 'nodejs';

// PO 텔레그램 chat_id — env 우선, 없으면 최근 텔레그램 명령에서 자동 추출(enqueue-audit.js와 동일 전략)
async function resolveChatId(sb: ReturnType<typeof createAdminClient>): Promise<number | null> {
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

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const agent: string | undefined = body.agent;
  if (!agent) return NextResponse.json({ ok: false, error: 'agent(대상 워커) 필요' }, { status: 400 });

  const sb = createAdminClient();
  const { data: a } = await sb.from('agents').select('name, control, status').eq('name', agent).maybeSingle();
  if (!a) return NextResponse.json({ ok: false, error: '없는 워커: ' + agent }, { status: 404 });

  // ── 워커 제어 (급정지/재가동) ──
  if (body.control === 'run' || body.control === 'stop') {
    await sb.from('agents').update({ control: body.control }).eq('name', agent);
    return NextResponse.json({ ok: true, note: body.control === 'stop' ? '급정지 신호' : '재가동 신호' });
  }
  // ── 종료: 실행 정지 + 이 워커의 대기·진행 작업을 끝냄(재개 안 됨) ──
  if (body.control === 'terminate') {
    await sb.from('agents').update({ control: 'stop' }).eq('name', agent);
    await sb.from('tasks').update({ status: 'failed', result: '⛔ 종료됨' })
      .eq('assigned_agent', agent).in('status', ['queued', 'in_progress']);
    return NextResponse.json({ ok: true, note: '작업 종료' });
  }

  // ── 새 명령 발행 (카드 탭 대상에 태스크 큐잉) ──
  const text = (body.text || '').trim();
  if (!text) return NextResponse.json({ ok: false, error: '명령 텍스트 필요' }, { status: 400 });
  const chatId = await resolveChatId(sb); // 결과를 텔레그램으로 돌려받기 위해 실는다
  const { data, error } = await sb
    .from('tasks')
    .insert({ command_text: text, assigned_agent: agent, status: 'queued', source_chat_id: chatId })
    .select()
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, task: data });
}
