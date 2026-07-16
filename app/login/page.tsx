'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // 사이트 내 경로만 허용(외부 URL·//호스트 차단) — next에 쿼리가 실려도(딥링크 보존) 안전하게 통과.
  //   백슬래시도 차단 — URL 파서가 /\evil.com 을 //evil.com(프로토콜 상대 외부 URL)으로 정규화하는 변종 봉합(감사 권고 2026-07-17).
  const rawNext = params.get('next') || '/';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.includes('\\') ? rawNext : '/';
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).catch(() => null);
    setBusy(false);
    if (res && res.ok) {
      router.push(next);
      router.refresh();
    } else {
      setErr('비밀번호가 틀렸습니다.');
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="wordmark" style={{ marginBottom: 18 }}>
          POCKET <span className="accent">COMMANDER</span>
          <span className="sub">AUTHORIZED ACCESS ONLY</span>
        </div>
        <input
          className="login-input"
          type="password"
          placeholder="비밀번호"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
        />
        {err && <div className="login-err">{err}</div>}
        <button className="login-btn" type="submit" disabled={busy}>
          {busy ? '확인 중…' : '입장'}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
