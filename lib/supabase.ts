import { createClient } from '@supabase/supabase-js';

// 브라우저(대시보드)용 — anon 키. 읽기 + Realtime 구독.
export function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null; // 미설정이면 대시보드는 데모 모드로 동작
  return createClient(url, anon, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

// 서버(API 라우트 / 워커 / 모니터)용 — service_role 키. 쓰기 포함, RLS 우회.
export function createAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
  }
  return createClient(url, service, { auth: { persistSession: false } });
}
