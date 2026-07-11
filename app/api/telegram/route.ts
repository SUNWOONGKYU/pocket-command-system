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

  // /명단 (/workers) : @직접지정에 쓸 워커 이름 목록
  if (text.trim() === '/명단' || text.trim() === '/workers') {
    const { data } = await supabase.from('agents').select('name,kind');
    const names = (data ?? []).filter((a) => a.kind !== 'orchestrator' && !a.name.endsWith('감사관')).map((a) => a.name);
    await sendTelegram(chatId, `👥 워커 (앞에 <b>@</b> 붙여 직접 지정)\n명령: <code>@알파 버그 수정해줘</code>\n제어: <code>급정지 알파</code> · <code>재가동 알파</code> · <code>종료 알파</code>\n\n${names.map((n) => '@' + n).join('\n')}`);
    return NextResponse.json({ ok: true });
  }

  // 1) 명단 로드
  const { data: agents } = await supabase.from('agents').select('*');
  if (!agents?.length) {
    await sendTelegram(chatId, '⚠️ 에이전트 명단이 비어 있습니다. schema.sql 시드를 확인하세요.');
    return NextResponse.json({ ok: true });
  }

  const executable = (agents as Agent[]).filter((a) => a.kind !== 'orchestrator');

  // ── 워커 제어 (대시보드 퀵버튼과 동일): "급정지 알파" / "알파 재가동" / "종료 에코" / "전원 급정지" ──
  //   텍스트에서 @·전원·워커명·구분자를 걷어내고 남은 게 제어 키워드 하나뿐일 때만 제어로 간주(일반 명령 오인 방지).
  {
    const isAll = /(전원|@all)/i.test(text);
    // ★ 감사관은 자동 전용 — 제어(급정지/재가동/종료) 대상에서도 제외 (지정 불가 불변식)
    //   긴 이름 우선 매칭(@지정과 일관) — 접두 중복 이름에서도 정확한 워커 선택
    const worker = isAll ? null : [...executable.filter((a) => !a.name.endsWith('감사관'))]
      .sort((a, b) => b.name.length - a.name.length)
      .find((a) => text.includes(a.name));
    let rem = text.replace(/@all/gi, '').replace('@', '').replace(/전원/g, '');
    if (worker) rem = rem.replace(worker.name, '');
    rem = rem.replace(/[\s,·:]/g, '').trim();
    const kind =
      /^(급정지|일시정지|정지|중지|멈춰|멈춤|그만|stop|pause)$/i.test(rem) ? 'stop' :
      /^(재가동|재개|resume|run)$/i.test(rem) ? 'run' :
      /^(종료|끝내|끝냄|끝|terminate|kill)$/i.test(rem) ? 'terminate' : null;
    if (kind && (isAll || worker)) {
      const targets = isAll ? executable.filter((a) => !a.name.endsWith('감사관')) : [worker!];
      const names = targets.map((a) => a.name);
      if (kind === 'run') {
        await supabase.from('agents').update({ control: 'run' }).in('name', names);
        await sendTelegram(chatId, `▶️ <b>재가동</b> — ${names.join(', ')}`);
      } else if (kind === 'stop') {
        await supabase.from('agents').update({ control: 'stop' }).in('name', names);
        await sendTelegram(chatId, `⏸️ <b>급정지</b> — ${names.join(', ')} (재가동으로 이어감)`);
      } else {
        await supabase.from('agents').update({ control: 'stop' }).in('name', names);
        await supabase.from('tasks').update({ status: 'failed', result: '⛔ 종료됨' })
          .in('assigned_agent', names).in('status', ['queued', 'in_progress']);
        await sendTelegram(chatId, `⛔ <b>종료</b> — ${names.join(', ')} (작업 끝냄, 재개 안 됨)`);
      }
      return NextResponse.json({ ok: true });
    }
  }

  // ── 세션 초기화: "새세션 알파" / "리셋 브라보" → 대화 맥락 끊기 (감사관 제외) ──
  if (/(^|\s)(새세션|리셋|reset)(\s|$)/i.test(text)) {
    const isAll = /(전원|@all)/i.test(text);
    const targets = (isAll ? executable : executable.filter((a) => text.includes(a.name))).filter((a) => !a.name.endsWith('감사관'));
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

  // ── 직접 지정: "@워커명 명령…" → 오케스트레이터 생략하고 그 워커로 바로 (콕핏 탭-지정과 동일) ──
  const trimmed = text.trim();
  if (trimmed.startsWith('@')) {
    const rest = trimmed.slice(1);
    // 긴 이름 우선 매칭 ('알파 감사관'이 '알파'보다 먼저 / 'Worker Name' 등 공백 포함 이름 대응)
    const worker = [...executable]
      .sort((a, b) => b.name.length - a.name.length)
      .find((a) => rest.startsWith(a.name));
    // ★ 감사관은 자동 전용 — @직접지정 대상에서 제외(브로드캐스트·/명단과 동일 불변식). 매칭은 정확히 하되
    //   감사관이면 명시 거부 → '@에코 감사관'이 '에코' 워커로 잘못 배정되는 오라우팅도 함께 방지.
    if (worker && worker.name.endsWith('감사관')) {
      await sendTelegram(chatId, `⚠️ <b>${worker.name}</b>은(는) 감사관이라 직접 지정할 수 없습니다. 감사관은 커밋 자동 감사 전용입니다.`);
      return NextResponse.json({ ok: true });
    }
    if (worker) {
      const cmd = rest.slice(worker.name.length).replace(/^[\s,:>·]+/, '').trim();
      if (!cmd) {
        await sendTelegram(chatId, `⚠️ <b>@${worker.name}</b> 뒤에 명령을 적어주세요.`);
        return NextResponse.json({ ok: true });
      }
      const { error: e2 } = await supabase.from('tasks').insert({
        command_text: cmd, assigned_agent: worker.name, status: 'queued', source_chat_id: chatId,
      });
      if (e2) { await sendTelegram(chatId, `⚠️ 접수 실패: ${e2.message}`); return NextResponse.json({ ok: true }); }
      await sendTelegram(chatId, `🎯 <b>${worker.name}</b>에게 직접 배정 (오케스트레이터 생략)\n\n“${cmd}”`);
      return NextResponse.json({ ok: true });
    }
    await sendTelegram(chatId, `⚠️ '@' 뒤 워커명을 못 찾았습니다. <code>/명단</code>으로 이름을 확인하세요.`);
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
