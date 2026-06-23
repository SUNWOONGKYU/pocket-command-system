// 비밀번호 검증 → 인증 쿠키(pc_auth) 발급. 미들웨어가 이 쿠키를 검사한다.

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';

const SALT = '::pocket-commander-gate';

export async function POST(req: Request) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return NextResponse.json({ ok: true, note: '게이트 비활성' });

  const { password } = await req.json().catch(() => ({}));
  if (password !== pw) {
    return NextResponse.json({ ok: false, error: '비밀번호가 틀렸습니다.' }, { status: 401 });
  }

  // 미들웨어와 동일한 SHA-256 토큰을 쿠키로 (평문 비번 저장 회피)
  const tok = createHash('sha256').update(pw + SALT).digest('hex');
  const res = NextResponse.json({ ok: true });
  res.cookies.set('pc_auth', tok, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30일
  });
  return res;
}
