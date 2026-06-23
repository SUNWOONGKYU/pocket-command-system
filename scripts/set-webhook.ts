// 텔레그램 봇 Webhook 을 이 앱의 /api/telegram 으로 등록한다.
// 실행:  npm run set-webhook
// 사전: .env.local 에 TELEGRAM_BOT_TOKEN, PUBLIC_BASE_URL 설정.

// tsx 단독 실행이라 Next.js 가 .env.local 을 자동 로드하지 않는다 → 직접 로드.
try { process.loadEnvFile('.env.local'); } catch { /* 파일 없으면 셸 환경변수 사용 */ }

const token = process.env.TELEGRAM_BOT_TOKEN;
const base = process.env.PUBLIC_BASE_URL;

if (!token || !base) {
  console.error('TELEGRAM_BOT_TOKEN, PUBLIC_BASE_URL 가 필요합니다 (.env.local).');
  process.exit(1);
}

const webhookUrl = `${base.replace(/\/$/, '')}/api/telegram`;

(async () => {
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] }),
  });
  const data = await res.json();
  console.log('setWebhook →', webhookUrl);
  console.log(data);
})();
