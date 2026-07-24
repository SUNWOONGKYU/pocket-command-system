// 이 PC(hostname)에 등록된 소대장/legacy worker 이름을 scripts/.my-agents.txt (UTF-8)로 기록.
// update.ps1 이 이 파일을 UTF-8로 읽어 워커를 재기동한다. (한글 이름 인코딩 안전 — 파일 경유)
// legacy orchestrator row는 PCSS 직접 지휘 대상이 아니므로 제외.
process.loadEnvFile('.env.local');
globalThis.WebSocket = require('ws');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

(async () => {
  const host = os.hostname();
  const { data, error } = await sb.from('agents').select('name,kind,host').eq('host', host);
  if (error) { console.error(error.message); process.exit(1); }
  const names = (data || []).filter((a) => a.kind !== 'orchestrator').map((a) => a.name);
  const out = path.join(__dirname, '.my-agents.txt');
  fs.writeFileSync(out, names.join('\n'), { encoding: 'utf8' });
  console.log(`이 PC(${host}) 워커 ${names.length}개: ${names.join(', ') || '(없음)'}`);
})();
