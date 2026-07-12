import type { MetadataRoute } from 'next';

// 홈 화면 설치(PWA)용 매니페스트 — Next가 /manifest.webmanifest 로 자동 서빙 + <link rel="manifest"> 자동 삽입
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'POCKET COMMAND SYSTEM',
    short_name: 'Command System',
    description: '주머니 속 지휘소 — 폰에서 지휘하는 AI 에이전트 관제 시스템',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0e0a',
    theme_color: '#0a0e0a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
