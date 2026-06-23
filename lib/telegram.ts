// 텔레그램 Bot API 래퍼 (결과/경고 회신용)

const API = (method: string) =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

export async function sendTelegram(chatId: number | string, text: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN 미설정 — 전송 생략:', text);
    return;
  }
  try {
    await fetch(API('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (e) {
    console.error('[telegram] 전송 실패', e);
  }
}
