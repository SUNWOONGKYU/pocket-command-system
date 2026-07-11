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

  // 구독 사용량(rate limit) 경고 — host당 1회로 묶어서 발송(같은 host=같은 계정=같은 사용량).
  // key=host, 그 host의 워커 이름들 + 대표 usage_state(가장 높은 pct)를 모은다.
  //   ★ alerted는 대표 row 1개가 아니라 '그 host의 어느 row든' alerted_for_reset이 이번 resetsAt과 일치하면
  //   매칭으로 본다 — 동률/근사 pct일 때 select 순서에 따라 대표가 바뀌면 그 row엔 플래그가 없어 재경고가
  //   나가던 문제 방지. 발송 후에도 host의 모든 워커 row에 플래그를 기록한다(아래 두 번째 루프).
  const usageByHost = new Map<string, { names: string[]; pct: number; resetsAt: string; alerted: boolean }>();

  for (const a of agents as Agent[]) {
    if (a.kind === 'orchestrator') continue; // 오케스트레이터는 워커가 없어 하트비트 없음 — 감시 제외
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

    // 구독 사용량(rate limit) — warning(80%) 이상인 워커를 host별로 모아둔다(발송은 루프 밖에서 host당 1회).
    const u = a.usage_state as { five_hour?: { pct: number; resets_at: string | null }; alerted_for_reset?: string } | null;
    if (u?.five_hour && (u.five_hour.pct ?? 0) >= 80 && a.host) {
      const resetsAt = u.five_hour.resets_at || '';
      const entry = usageByHost.get(a.host);
      const alreadyAlerted = !!(u.alerted_for_reset && u.alerted_for_reset === resetsAt);
      if (!entry || u.five_hour.pct > entry.pct) {
        usageByHost.set(a.host, {
          names: entry ? [...entry.names, a.name] : [a.name],
          pct: u.five_hour.pct,
          resetsAt,
          alerted: (entry?.alerted ?? false) || alreadyAlerted,
        });
      } else {
        entry.names.push(a.name);
        entry.alerted = entry.alerted || alreadyAlerted;
      }
    }
  }

  // host별로 새로 80% 이상 진입했을 때만 1회 경고 + 그 host의 모든 워커 row에 alerted_for_reset 기록.
  for (const [host, info] of usageByHost) {
    if (info.alerted) continue; // 이 host의 어느 워커든 이미 이 리셋 주기에 대해 알림 — 중복 방지(리셋 지나면 resetsAt이 바뀌어 다시 알림)
    const resetTime = info.resetsAt
      ? new Date(info.resetsAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
      : '—';
    flagged.push(`⚠️ ${host} 구독 사용량 ${info.pct}% (5h 윈도) — ${resetTime} 리셋. 워커: ${info.names.join(', ')}`);
    // 대표 1개가 아니라 이 host의 모든 워커 row에 플래그를 남겨야, 다음 cron에서 어느 row가 먼저 잡히든 안전하다.
    for (const a of agents as Agent[]) {
      if (a.host !== host) continue;
      await supabase.from('agents')
        .update({ usage_state: { ...(a.usage_state ?? {}), alerted_for_reset: info.resetsAt } })
        .eq('id', a.id);
    }
  }

  if (flagged.length && alertChat && !ALERTS_DISABLED) {
    await sendTelegram(alertChat, `🚨 <b>관제 경고</b>\n${flagged.join('\n')}`);
  }

  return NextResponse.json({ ok: true, checked: agents.length, flagged });
}
