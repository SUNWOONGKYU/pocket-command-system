// 감시 Cron: 하트비트 타임아웃 → offline 표시 + 텔레그램 경고
// Vercel Cron(vercel.json) 또는 외부 스케줄러가 30초~1분 주기로 GET 호출.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';
import { sendTelegram } from '@/lib/telegram';
import { HEARTBEAT_TIMEOUT_SEC, STUCK_TIMEOUT_SEC } from '@/lib/types';
import type { Agent } from '@/lib/types';

// 2026-06-24 PO 지시: 관제 경고(텔레그램)를 영구 비활성. 워커 데몬 정지 시 매분 스팸이 나가던 문제.
// 상태 갱신(offline 표시) 로직은 유지하되, 텔레그램 경고 발송만 차단한다.
// (cron 자체도 vercel.json에서 제거됨 — 이건 이중 안전장치.) 다시 켜려면 false.
const ALERTS_DISABLED = true;

export const runtime = 'nodejs';
// GET 라우트라 Next가 빌드 타임에 정적 평가(프리렌더)하려 한다 →
// 그 시점엔 env가 없어 createAdminClient()가 throw. Cron이 매번 호출하는 동적 엔드포인트이므로 강제 동적화.
export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createAdminClient();
  const { data: agents } = await supabase.from('agents').select('*');
  if (!agents?.length) return NextResponse.json({ ok: true, checked: 0 });

  const now = Date.now();
  const alertChat = process.env.TELEGRAM_ALERT_CHAT_ID;
  const flagged: string[] = [];

  for (const a of agents as Agent[]) {
    if (a.kind === 'orchestrator') continue; // 허실장 등 오케스트레이터는 워커가 없어 하트비트 없음 — 감시 제외
    const lastBeat = a.last_heartbeat_at ? new Date(a.last_heartbeat_at).getTime() : 0;
    const sinceBeat = (now - lastBeat) / 1000;

    // 응답 없음: 하트비트 끊김 → status를 offline으로 (이미 offline이면 중복 경고 안 함)
    if ((!a.last_heartbeat_at || sinceBeat > HEARTBEAT_TIMEOUT_SEC) && a.status !== 'offline') {
      await supabase.from('agents').update({ status: 'offline' }).eq('id', a.id);
      flagged.push(`🔴 ${a.name} 응답 없음 (${Math.round(sinceBeat)}s)`);
      continue;
    }

    // 정체: working 인데 너무 오래 진행 없음 → 경고만(상태는 유지)
    if (a.status === 'working') {
      const sinceUpdate = (now - new Date(a.updated_at).getTime()) / 1000;
      if (sinceUpdate > STUCK_TIMEOUT_SEC) {
        flagged.push(`🟡 ${a.name} 작업 정체 (${Math.round(sinceUpdate)}s)`);
      }
    }
  }

  if (flagged.length && alertChat && !ALERTS_DISABLED) {
    await sendTelegram(alertChat, `🚨 <b>관제 경고</b>\n${flagged.join('\n')}`);
  }

  return NextResponse.json({ ok: true, checked: agents.length, flagged });
}
