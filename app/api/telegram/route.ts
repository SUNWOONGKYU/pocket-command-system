// 텔레그램 Webhook 수신 → 조회 전용 응답만.
// PO 지시(2026-07-13): 텔레그램은 보는 용도로만 사용. 명령 입력(자연어 라우팅/직접지정/브로드캐스트/
// 워커제어/세션리셋)은 전부 막고 콕핏 대시보드로 유도한다 — 텔레그램발 자연어 라우팅이 오배정의 원인이었음.
// 명령 발행은 콕핏(app/api/command/route.ts)에서만 — 오케스트레이터(lib/orchestrator.ts)는 이 경로가
// 없어지며 호출부가 사라졌다(코드는 향후 재활성화 대비로 남겨둠).
// 텔레그램 봇 설정: scripts/set-webhook.ts 로 이 경로를 등록한다.
//   https://<배포도메인>/api/telegram

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';
import { sendTelegram } from '@/lib/telegram';

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

  // /명단 (/workers) : 조회 전용 — 워커 이름 목록
  if (text.trim() === '/명단' || text.trim() === '/workers') {
    const { data } = await supabase.from('agents').select('name,kind');
    const names = (data ?? []).filter((a) => a.kind !== 'orchestrator' && !a.name.endsWith('감사관')).map((a) => a.name);
    await sendTelegram(chatId, `👥 워커 목록 (명령은 콕핏 대시보드에서)\n\n${names.join('\n')}`);
    return NextResponse.json({ ok: true });
  }

  // 그 외 모든 입력 — 조회 전용 안내만 하고 아무 것도 큐에 넣지 않는다.
  await sendTelegram(
    chatId,
    '👀 텔레그램은 <b>보는 용도(조회 전용)</b>입니다. 명령은 콕핏 대시보드에서 내려주세요.\n조회 가능: <code>/status</code> · <code>/명단</code>'
  );
  return NextResponse.json({ ok: true });
}
