'use client';

import { Task } from '@/lib/types';

const STATUS_TEXT: Record<string, string> = {
  queued: '접수 → 배정 대기',
  in_progress: '작업 착수',
  done: '완료',
  failed: '실패',
};

export default function TaskFeed({ tasks }: { tasks: Task[] }) {
  return (
    <section className="feed">
      <h2>▦ Live Feed</h2>
      {tasks.length === 0 && (
        <div className="event">
          <div className="msg" style={{ color: 'var(--text-dim)' }}>
            아직 지시가 없습니다. 텔레그램으로 명령을 던지면 여기에 흐릅니다.
          </div>
        </div>
      )}
      {tasks.map((t) => (
        <div className="event" key={t.id + t.status}>
          <div className="ts">{new Date(t.updated_at).toLocaleTimeString('ko-KR', { hour12: false })}</div>
          <div className="msg">
            <span className="who">{t.assigned_agent ?? '미배정'}</span> · {STATUS_TEXT[t.status] ?? t.status}
            <br />
            <span style={{ color: 'var(--text-dim)' }}>“{t.command_text}”</span>
          </div>
        </div>
      ))}
    </section>
  );
}
