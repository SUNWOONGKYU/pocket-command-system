// 첨부파일 기능 인프라 셋업 — 멱등(idempotent). 실행: node scripts/setup-attachments.mjs
//
// 하는 일:
//   1) Supabase Storage 비공개 버킷 'task-attachments' 생성 (이미 있으면 skip).
//      · public=false — 접근은 항상 signed URL(만료)로만. service_role이 URL을 발급한다.
//      · 파일 크기 제한 20MB(업로드 API와 동일).
//   2) tasks.attachments(jsonb) 컬럼 마이그레이션 안내 출력.
//      · supabase-js는 임의 DDL을 실행할 수 없다 → 컬럼은 supabase/schema.sql 의
//        `alter table if exists tasks add column if not exists attachments jsonb;` 를
//        Supabase 대시보드 > SQL Editor 에 붙여 실행한다(멱등). 이 스크립트는 실행 여부만 확인·안내한다.
//
// .env.local 의 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 를 사용한다(시크릿 하드코딩 없음).

import { createClient } from '@supabase/supabase-js';
import ws from 'ws'; // Node 20은 네이티브 WebSocket이 없어 createClient의 realtime 초기화가 throw — 워커와 동일하게 ws 주입

// Next.js 밖 단독 실행이라 .env.local 을 직접 로드.
try { process.loadEnvFile('.env.local'); } catch { /* 파일 없으면 셸 환경변수 사용 */ }

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다 (.env.local 확인).');
  process.exit(1);
}

const BUCKET = 'task-attachments';
const MAX_SIZE = 20 * 1024 * 1024;

const sb = createClient(url, key, { auth: { persistSession: false }, realtime: { transport: ws } });

async function main() {
  // ── 1) 버킷 (멱등) ──
  const { data: buckets, error: listErr } = await sb.storage.listBuckets();
  if (listErr) {
    console.error('✗ 버킷 목록 조회 실패:', listErr.message);
    process.exit(1);
  }
  const exists = (buckets || []).some((b) => b.name === BUCKET);
  if (exists) {
    console.log(`• 버킷 '${BUCKET}' 이미 존재 — skip`);
  } else {
    const { error: createErr } = await sb.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: MAX_SIZE,
    });
    if (createErr) {
      console.error(`✗ 버킷 '${BUCKET}' 생성 실패:`, createErr.message);
      process.exit(1);
    }
    console.log(`✓ 버킷 '${BUCKET}' 생성됨 (private, 20MB 제한)`);
  }

  // ── 2) tasks.attachments 컬럼 확인 ──
  //   존재 여부만 가볍게 확인(select 시 컬럼 없으면 에러) — 없으면 SQL 실행을 안내한다.
  const { error: colErr } = await sb.from('tasks').select('attachments').limit(1);
  if (colErr && /column .*attachments.* does not exist/i.test(colErr.message)) {
    console.log('• tasks.attachments 컬럼 없음 — 아래 SQL을 Supabase 대시보드 > SQL Editor 에서 실행하세요:');
    console.log('    alter table if exists tasks add column if not exists attachments jsonb;');
    console.log('  (supabase/schema.sql 에도 이미 포함되어 있습니다.)');
  } else if (colErr) {
    console.log('• tasks.attachments 확인 중 경고:', colErr.message);
  } else {
    console.log('• tasks.attachments 컬럼 존재 확인 — OK');
  }

  console.log('\n완료. 이제 콕핏 컴포저의 📎로 첨부를 보낼 수 있습니다.');
}

main().catch((e) => { console.error('✗ 셋업 오류:', e); process.exit(1); });
