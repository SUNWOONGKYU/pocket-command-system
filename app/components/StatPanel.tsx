'use client';

import { Agent, deriveStatus, STATUS_META, DerivedStatus } from '@/lib/types';

export default function StatPanel({ agents, now }: { agents: Agent[]; now: number }) {
  const counts: Record<DerivedStatus, number> = { working: 0, idle: 0, stuck: 0, offline: 0, error: 0, command: 0 };
  agents.forEach((a) => counts[deriveStatus(a, now)]++);
  const total = agents.length || 1;
  const active = counts.working;
  const rate = Math.round((active / total) * 100);

  const order: DerivedStatus[] = ['working', 'idle', 'stuck', 'offline'];

  return (
    <aside className="side">
      <div>
        <div className="eyebrow">가동률 · OPS RATE</div>
        <div className="bigstat" style={{ marginTop: 8 }}>
          <span className="num">{rate}</span>
          <span className="unit">%</span>
        </div>
      </div>

      <div className="barmeter">
        {order.map((s) =>
          counts[s] ? (
            <span key={s} style={{ background: STATUS_META[s].color, width: `${(counts[s] / total) * 100}%` }} />
          ) : null
        )}
      </div>

      <div className="legend">
        {order.map((s) => (
          <div className="row" key={s}>
            <span className="name">
              <span className="pip" style={{ background: STATUS_META[s].color }} />
              {STATUS_META[s].label}
            </span>
            <span>{counts[s]}</span>
          </div>
        ))}
        <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 9, marginTop: 2 }}>
          <span className="name">총 인원</span>
          <span>{agents.length}</span>
        </div>
      </div>
    </aside>
  );
}
