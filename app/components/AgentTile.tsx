'use client';

import { Agent, deriveStatus, STATUS_META } from '@/lib/types';

// 살아있는 에이전트: 심전도 파형. offline: 평평한 직선.
const EKG_TRACE =
  'M0 13 L34 13 L40 13 L44 4 L49 22 L54 13 L72 13 L78 13 L82 9 L86 13 L120 13 ' +
  'L154 13 L160 13 L164 4 L169 22 L174 13 L192 13 L198 13 L202 9 L206 13 L240 13';
const EKG_FLAT = 'M0 13 L240 13';

export default function AgentTile({ agent, now }: { agent: Agent; now: number }) {
  const state = deriveStatus(agent, now);
  const meta = STATUS_META[state];
  const flat = state === 'offline';

  return (
    <div
      className="tile"
      data-state={state}
      style={{ borderColor: state === 'idle' ? 'var(--line)' : meta.color + '55' }}
    >
      <span className="corner" style={{ background: meta.color }} />
      <div className="top">
        <span className="name">{agent.name}</span>
        <span className="squad">{agent.squad}</span>
      </div>
      <div className="role">{agent.role}</div>

      <div className="status-line">
        <span className="stat-label">
          <span className="stat-dot" style={{ background: meta.color, boxShadow: `0 0 8px ${meta.glow}` }} />
          <span style={{ color: meta.color }}>{meta.label}</span>
        </span>
        <span className="beats">♥ {agent.beats.toLocaleString()}</span>
      </div>

      <div className="ekg">
        <svg viewBox="0 0 240 26" preserveAspectRatio="none">
          <path
            className="trace"
            d={flat ? EKG_FLAT : EKG_TRACE}
            stroke={meta.color}
            style={{ filter: `drop-shadow(0 0 3px ${meta.glow})` }}
          />
        </svg>
      </div>
    </div>
  );
}
