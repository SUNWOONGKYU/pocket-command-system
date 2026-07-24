import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'POCKET COMMAND SUPPORTING SYSTEM',
  description: '주머니 속 AI 작업팀 지휘통제 지원 시스템 — PCSS',
  // 홈 화면 설치(iOS/Android)용
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'PCSS' },
  icons: { icon: '/icon-192.png', apple: '/apple-touch-icon.png' },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0B0F17',
  // 키보드가 뜨면 레이아웃 뷰포트를 줄여 고정 입력창(컴포저)이 키보드 위에 남게 (Android Chrome)
  interactiveWidget: 'resizes-content' as const,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
