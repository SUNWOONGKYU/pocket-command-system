import { redirect } from 'next/navigation';

// 관제 보드는 콕핏에 통합(하트비트 EKG를 콕핏 카드로). 루트는 콕핏으로. (콘솔은 /console 유지)
export default function Home() {
  redirect('/cockpit');
}
