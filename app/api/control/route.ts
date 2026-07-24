// 콘솔 버튼용 서버 액션 — 취소 / 재시도
// 브라우저(anon)는 RLS로 읽기만 되므로, 쓰기는 이 라우트(service_role)를 거친다.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const { action, taskId } = await req.json().catch(() => ({}));
  if (!action || !taskId) return NextResponse.json({ ok: false, error: 'action/taskId 필요' }, { status: 400 });

  const sb = createAdminClient();
  const { data: task } = await sb.from('tasks').select('*').eq('id', taskId).single();
  if (!task) return NextResponse.json({ ok: false, error: 'task 없음' }, { status: 404 });

  // ── 취소 ──
  if (action === 'cancel') {
    if (task.status === 'in_progress' && task.assigned_agent) {
      // 실행 중: 담당 에이전트에 중단 신호 → 워커가 프로세스 kill
      await sb.from('agents').update({ control: 'stop' }).eq('name', task.assigned_agent);
      return NextResponse.json({ ok: true, note: '중단 신호 전송' });
    }
    // 대기 중: 그냥 취소 처리
    await sb.from('tasks').update({ status: 'failed', result: '⛔ 취소됨' }).eq('id', taskId);
    return NextResponse.json({ ok: true, note: '대기 작업 취소' });
  }

  // ── 재시도 ── 같은 명령으로 새 작업을 큐에 다시 적재 (원본은 보존)
  if (action === 'retry') {
    const legacyRetryPayload = {
      command_text: task.command_text,
      assigned_agent: task.assigned_agent,
      status: 'queued',
      source_chat_id: task.source_chat_id,
    };
    const retryPayload = {
      ...legacyRetryPayload,
      assigned_platoon_id: task.assigned_platoon_id ?? null,
      ordered_by: task.ordered_by ?? 'legacy_unspecified',
      task_type: `${task.task_type ?? 'legacy_task'}_retry`.slice(0, 80),
      parent_task_id: task.id,
      audit_id: task.audit_id ?? null,
    };
    let { error } = await sb.from('tasks').insert(retryPayload);
    if (error && /assigned_platoon_id|ordered_by|task_type|parent_task_id|audit_id|column/i.test(error.message)) {
      const retry = await sb.from('tasks').insert(legacyRetryPayload);
      error = retry.error;
    }
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, note: '재시도 큐 적재' });
  }

  return NextResponse.json({ ok: false, error: '알 수 없는 action' }, { status: 400 });
}
