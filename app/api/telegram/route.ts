// 텔레그램 Webhook 수신 → 오케스트레이터이 배분 → tasks 큐에 적재 → 접수 회신
// 텔레그램 봇 설정: scripts/set-webhook.ts 로 이 경로를 등록한다.
//   https://<배포도메인>/api/telegram

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';
import { routeCommand } from '@/lib/orchestrator';
import { sendTelegram } from '@/lib/telegram';
import type { Agent } from '@/lib/types';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const update = await req.json().catch(() => null);
  const message = update?.message;
  const text: string | undefined = message?.text;
  const chatId: number | undefined = message?.chat?.id;

  if (!text || !chatId) return NextResponse.json({ ok: true }); // 무시

  const supabase = createAdminClient();

  // /status : 현재 현황 브리핑
  if (text.trim() === '/status') {
    const { data } = await supabase.from('agents').select('name,status');
    const working = (data ?? []).filter((a) => a.status === 'working').length;
    const idle = (data ?? []).filter((a) => a.status === 'idle').length;
    await sendTelegram(chatId, `📊 현황 — 작업 중 ${working} · 대기 ${idle} / 총 ${data?.length ?? 0}명`);
    return NextResponse.json({ ok: true });
  }

  // 1) 명단 로드
  const { data: agents } = await supabase.from('agents').select('*');
  if (!agents?.length) {
    await sendTelegram(chatId, '⚠️ 에이전트 명단이 비어 있습니다. schema.sql 시드를 확인하세요.');
    return NextResponse.json({ ok: true });
  }

  const executable = (agents as Agent[]).filter((a) => a.kind !== 'orchestrator');

  // ── 중단: "정지 찰리조" / "찰리조 그만" / "전원 정지" ──
  if (/(^|\s)(정지|중지|그만|멈춰|stop)(\s|$)/i.test(text)) {
    const isAll = /(전원|@all)/i.test(text);
    const targets = isAll ? executable : executable.filter((a) => text.includes(a.name));
    if (targets.length) {
      const names = targets.map((a) => a.name);
      // 1) 실행 중인 작업: control='stop' → 워커가 프로세스 kill
      await supabase.from('agents').update({ control: 'stop' }).in('name', names);
      // 2) 큐에 대기 중인 작업: 취소 처리
      await supabase
        .from('tasks')
        .update({ status: 'failed', result: '⛔ 취소됨(대기 중)' })
        .in('assigned_agent', names)
        .eq('status', 'queued');
      await sendTelegram(chatId, `⛔ <b>중단 지시</b> — ${names.join(', ')} (${names.length}명)`);
      return NextResponse.json({ ok: true });
    }
  }

  // ── 세션 초기화: "새세션 정화백" / "리셋 찰리조" → 대화 맥락 끊기 ──
  if (/(^|\s)(새세션|리셋|reset)(\s|$)/i.test(text)) {
    const isAll = /(전원|@all)/i.test(text);
    const targets = isAll ? executable : executable.filter((a) => text.includes(a.name));
    if (targets.length) {
      const names = targets.map((a) => a.name);
      await supabase.from('agents').update({ session_id: null }).in('name', names);
      await sendTelegram(chatId, `🔄 세션 초기화 — ${names.join(', ')}`);
      return NextResponse.json({ ok: true });
    }
  }

  // ── 브로드캐스트: "전원, ..." 또는 "@all ..." → 전 에이전트 동시 투입 ──
  const bcast = /^(전원|@all)[,\s]+(.+)/s.exec(text.trim());
  if (bcast) {
    const order = bcast[2];
    // ★ 감사관은 자동 전용 — 전원 브로드캐스트 배정에서도 제외(오케스트레이터가 감사관에게 일 안 줌).
    const targets = executable.filter((a) => !a.name.endsWith('감사관'));
    const rows = targets.map((a) => ({
      command_text: order,
      assigned_agent: a.name,
      status: 'queued' as const,
      source_chat_id: chatId,
    }));
    await supabase.from('tasks').insert(rows);
    await sendTelegram(
      chatId,
      `🫡 <b>오케스트레이터</b> 전원 투입 (${targets.length}명)\n“${order}”`
    );
    return NextResponse.json({ ok: true });
  }

  // 2) 직전 대화 상대(sticky) 조회 — 이 chat이 마지막으로 일을 맡긴 에이전트
  const { data: lastTask } = await supabase
    .from('tasks')
    .select('assigned_agent')
    .eq('source_chat_id', chatId)
    .not('assigned_agent', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const stickyAgent = lastTask?.assigned_agent ?? null;

  // 오케스트레이터가 담당 결정 (이름/주식/키워드 매칭 실패 시 → 직전 대화 상대로 이어감)
  const assignee = await routeCommand(text, agents as Agent[], stickyAgent);

  // 3) tasks 큐에 적재 (워커가 폴링해서 가져감)
  const { error } = await supabase.from('tasks').insert({
    command_text: text,
    assigned_agent: assignee,
    status: 'queued',
    source_chat_id: chatId,
  });

  if (error) {
    await sendTelegram(chatId, `⚠️ 접수 실패: ${error.message}`);
    return NextResponse.json({ ok: true });
  }

  // 4) 접수 회신
  await sendTelegram(
    chatId,
    `🫡 <b>오케스트레이터</b> 접수 완료\n→ <b>${assignee}</b>에게 배정했습니다.\n\n“${text}”`
  );
  return NextResponse.json({ ok: true });
}
