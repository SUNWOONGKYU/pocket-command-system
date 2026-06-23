'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Agent, deriveStatus, STATUS_META, DerivedStatus } from '@/lib/types';

export default function CommandBar({ agents, now, demo }: { agents: Agent[]; now: number; demo: boolean }) {
  const [clock, setClock] = useState('');
  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString('ko-KR', { hour12: false })), 1000);
    return () => clearInterval(t);
  }, []);

  const counts: Record<DerivedStatus, number> = { working: 0, idle: 0, stuck: 0, offline: 0, error: 0, command: 0 };
  agents.forEach((a) => counts[deriveStatus(a, now)]++);

  return (
    <header className="bar">
      <div className="wordmark">
        POCKET COMMAND <span className="accent">POST</span>
        <span className="sub">주머니 속 지휘소 · AI 에이전트 관제 · by Finder World</span>
      </div>
      <nav className="nav">
        <Link href="/" className="active">관제 보드</Link>
        <Link href="/console">콘솔</Link>
      </nav>
      <div className="bar-spacer" />
      {demo && <span className="demo-flag">DEMO MODE</span>}
      <div className="tallies">
        {(['working', 'idle', 'stuck', 'offline'] as DerivedStatus[]).map((s) => (
          <span className="tally" key={s}>
            <span className="pip" style={{ background: STATUS_META[s].color }} />
            {STATUS_META[s].label} <b>{counts[s]}</b>
          </span>
        ))}
      </div>
      <div className="clock">
        <span className="live-dot" />
        {clock}
      </div>
    </header>
  );
}
