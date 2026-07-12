// 첨부파일 업로드 API — 콕핏 컴포저의 📎로 고른 파일을 Supabase Storage에 올린다.
//   multipart/form-data(field: file, 복수 허용)를 받아 버킷 task-attachments 에 <uuid>/<원본명>으로 저장하고,
//   각 파일의 { path, url(signed·7일), name, size, mime } 메타를 반환한다. 이 메타를 /api/command 의
//   attachments 배열로 넘기면 tasks.attachments 에 실린다. 브라우저(anon)는 Storage 쓰기 권한이 없어
//   반드시 이 라우트(service_role)를 거친다.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export const runtime = 'nodejs';

const BUCKET = 'task-attachments';
const MAX_FILES = 5;
const MAX_SIZE = 20 * 1024 * 1024; // 20MB
const SIGNED_URL_TTL = 60 * 60 * 24 * 7; // 7일(초)

// 파일명 sanitize — 경로 성분(../ 등) 제거 + 허용 문자만 남긴다(한글·영숫자·._-()[]).
//   따옴표·제어문자·특수문자는 _ 로. 선행 . / _ 는 제거(숨김파일·상대경로 방지). 빈 이름은 'file' 폴백.
function sanitizeName(raw: string): string {
  const base = (raw || '').split(/[\\/]/).pop() || 'file'; // 경로 성분 제거(마지막 조각만)
  const cleaned = base
    .replace(/\s+/g, '_')                    // 공백류(제어문자 포함) → _
    .replace(/[^\w.\-가-힣()[\]]/g, '_')     // 허용 외 전부 → _
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+/, '');                  // 선행 . 나 _ 제거
  const safe = cleaned || 'file';
  return safe.length > 120 ? safe.slice(-120) : safe;
}

// crypto.randomUUID는 Node18+ 전역 제공 — 별도 import 불필요.

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'multipart/form-data 형식이 아닙니다.' }, { status: 400 });
  }

  const files = form.getAll('file').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ ok: false, error: '첨부할 파일이 없습니다.' }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ ok: false, error: `첨부는 최대 ${MAX_FILES}개까지 가능합니다.` }, { status: 400 });
  }
  for (const f of files) {
    if (f.size > MAX_SIZE) {
      return NextResponse.json({ ok: false, error: `"${f.name}"이(가) 20MB를 초과합니다.` }, { status: 400 });
    }
  }

  let sb: ReturnType<typeof createAdminClient>;
  try {
    sb = createAdminClient();
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }

  const out: { path: string; url: string; name: string; size: number; mime: string }[] = [];
  for (const f of files) {
    const name = sanitizeName(f.name);
    const path = `${crypto.randomUUID()}/${name}`;
    const buf = Buffer.from(await f.arrayBuffer());
    const mime = f.type || 'application/octet-stream';

    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, buf, {
      contentType: mime,
      upsert: false,
    });
    if (upErr) {
      return NextResponse.json({ ok: false, error: `업로드 실패("${f.name}"): ${upErr.message}` }, { status: 500 });
    }

    const { data: signed, error: signErr } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
    if (signErr || !signed?.signedUrl) {
      return NextResponse.json({ ok: false, error: `URL 생성 실패("${f.name}"): ${signErr?.message || '알 수 없음'}` }, { status: 500 });
    }

    out.push({ path, url: signed.signedUrl, name, size: f.size, mime });
  }

  return NextResponse.json({ ok: true, attachments: out });
}
