// 대시보드(/, /console) 비밀번호 게이트.
// DASHBOARD_PASSWORD 가 설정돼 있을 때만 동작 — 미설정이면 게이트 비활성(데모 공개).
// 봇/서버 간 호출(api/telegram·monitor·control)과 로그인 경로는 게이트에서 제외.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_API = ['/api/telegram', '/api/monitor', '/api/control', '/api/login'];
const SALT = '::pocket-commander-gate';

// 쿠키에 평문 비번을 두지 않도록 SHA-256 토큰으로 검증 (edge: Web Crypto)
async function token(pw: string): Promise<string> {
  const data = new TextEncoder().encode(pw + SALT);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function middleware(req: NextRequest) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return NextResponse.next(); // 게이트 비활성

  const { pathname } = req.nextUrl;
  // 로그인 화면 · 봇/서버 API · PWA 자산(매니페스트·아이콘 등 정적 파일)은 게이트 제외
  const isAsset = /\.(png|ico|svg|webmanifest|txt|json)$/.test(pathname) || pathname === '/manifest.webmanifest';
  if (pathname === '/login' || PUBLIC_API.some((p) => pathname.startsWith(p)) || isAsset) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get('pc_auth')?.value;
  if (cookie && cookie === (await token(pw))) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // 정적 자원/파비콘 제외 전 경로에서 동작
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
