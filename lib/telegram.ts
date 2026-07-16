// 텔레그램 Bot API 래퍼 (결과/경고 회신용)

const API = (method: string) =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

// 콕핏 대시보드 절대주소 — 회신 메시지의 바로가기 버튼용(PO 요청 2026-07-17).
// PUBLIC_BASE_URL 우선, 없으면 Vercel이 주입하는 프로덕션 도메인 폴백. 둘 다 없으면 버튼 생략.
function cockpitUrl(): string | null {
  const base =
    process.env.PUBLIC_BASE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null);
  return base ? `${base.replace(/\/$/, '')}/cockpit` : null;
}

export async function sendTelegram(chatId: number | string, text: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN 미설정 — 전송 생략:', text);
    return;
  }
  const url = cockpitUrl();
  try {
    await fetch(API('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...(url
          ? { reply_markup: { inline_keyboard: [[{ text: '🚀 콕핏 대시보드 열기', url }]] } }
          : {}),
      }),
    });
  } catch (e) {
    console.error('[telegram] 전송 실패', e);
  }
}
