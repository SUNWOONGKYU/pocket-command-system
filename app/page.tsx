'use client';

import { useEffect, useRef, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase';
import { Agent } from '@/lib/types';
import AgentTile from './components/AgentTile';
import CommandBar from './components/CommandBar';
import StatPanel from './components/StatPanel';

// ----- 데모 모드용 시드 (Supabase 미설정 시) -----
const DEMO_SEED: Omit<Agent, 'last_heartbeat_at' | 'beats' | 'updated_at'>[] = [
  ['오케스트레이터(참모장)', '총괄 지휘 · 작업 배분', '지휘부'],
  ['알파조', '데이터/유튜브 분석 리포트', '1중대'],
  ['정화백', '문서 정리 · 요약 · 교정', '1중대'],
  ['소통꾼', '메시지 작성 · 외부 소통', '1중대'],
  ['브라보조', '웹 리서치 · 자료 수집', '1중대'],
  ['찰리조', '코드 작성 · 디버깅', '2중대'],
  ['델타조', '이미지/SVG 렌더링', '2중대'],
  ['에코조', '번역 · 다국어 처리', '2중대'],
  ['폭스트롯', '일정 · 캘린더 관리', '2중대'],
  ['골프조', '재무 계산 · 표 작성', '3중대'],
  ['호텔조', 'QA · 결과 검수', '3중대'],
  ['인디아조', '크롤링 · 모니터링', '3중대'],
  ['줄리엣', '요약 브리핑 작성', '3중대'],
  ['킬로조', '아카이브 · 기록 관리', '4중대'],
  ['리마조', '알림 · 스케줄 트리거', '4중대'],
  ['마이크조', '예비 · 백업 처리', '4중대'],
].map(([name, role, squad]) => ({
  id: name,
  name,
  role,
  squad,
  kind: 'claude_api',
  host: null,
  workdir: null,
  entry: null,
  skill: null,
  session_id: null,
  status: 'idle' as const,
  control: 'run',
  current_task_id: null,
}));

export default function Page() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [now, setNow] = useState(Date.now());
  const [demo, setDemo] = useState(false);
  const demoRef = useRef<Agent[]>([]);

  // 1초 틱 — 파생 상태(offline/EKG)를 실시간 재계산
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const sb = createBrowserClient();

    // ===== 라이브 모드: Supabase Realtime (에이전트 상태 전용 — 작업 흐름은 콘솔에서) =====
    if (sb) {
      const load = async () => {
        const { data: a } = await sb.from('agents').select('*').order('squad');
        if (a) {
          // 정렬: 오케스트레이터(참모장) 맨 앞 → 중대 순 → 같은 중대 내에서 '워커 다음에 그 워커의 감사관'이
          // 바로 붙도록. 감사관은 감사 대상 워커의 중대를 따라가 그 워커 직후에 배치된다.
          const list = a as Agent[];
          const baseName = (n: string) => n.replace(/\s*감사관$/, '');
          const isAuditor = (n: string) => /감사관$/.test(n);
          const squadKey = (ag: Agent) => {
            const w = list.find((z) => z.name === baseName(ag.name));
            return w?.squad || ag.squad || '';
          };
          const sorted = list.slice().sort((x, y) => {
            const ox = x.kind === 'orchestrator' ? 0 : 1;
            const oy = y.kind === 'orchestrator' ? 0 : 1;
            if (ox !== oy) return ox - oy;
            const sq = squadKey(x).localeCompare(squadKey(y));
            if (sq) return sq;
            const bn = baseName(x.name).localeCompare(baseName(y.name));
            if (bn) return bn;
            return (isAuditor(x.name) ? 1 : 0) - (isAuditor(y.name) ? 1 : 0);
          });
          setAgents(sorted);
        }
      };
      load();
      // 실시간(Realtime) 연결이 끊겨도 화면이 옛 상태에 멈추지 않게 — 주기적 재동기화(자가 회복)
      const poll = setInterval(load, 20000);

      const ch = sb
        .channel('command-center')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, (p) => {
          const row = p.new as Agent;
          setAgents((prev) => prev.map((x) => (x.id === row.id ? row : x)));
        })
        .subscribe();

      return () => {
        clearInterval(poll);
        sb.removeChannel(ch);
      };
    }

    // ===== 데모 모드: 로컬 시뮬레이션 =====
    setDemo(true);
    const seeded: Agent[] = DEMO_SEED.map((a, i) => ({
      ...a,
      last_heartbeat_at: new Date().toISOString(),
      beats: Math.floor(Math.random() * 400),
      updated_at: new Date().toISOString(),
      status: i % 5 === 1 ? 'working' : 'idle',
    }));
    // 마이크조는 처음부터 응답 없음 상태로 시연
    seeded[seeded.length - 1].last_heartbeat_at = new Date(Date.now() - 60_000).toISOString();
    demoRef.current = seeded;
    setAgents([...seeded]);

    let offlineName = '마이크조';

    const beat = setInterval(() => {
      const arr = demoRef.current;
      arr.forEach((a) => {
        if (a.name === offlineName) return; // 오프라인은 안 뜀
        a.beats += 1;
        a.last_heartbeat_at = new Date().toISOString();
        // 가끔 상태 전이
        if (a.status === 'idle' && Math.random() < 0.04) {
          a.status = 'working';
          a.updated_at = new Date().toISOString();
        } else if (a.status === 'working' && Math.random() < 0.18) {
          a.status = 'idle';
          a.updated_at = new Date().toISOString();
        }
      });
      // 가끔 오프라인 에이전트가 복귀하고 다른 한 명이 끊김
      if (Math.random() < 0.05) {
        const reviving = arr.find((a) => a.name === offlineName);
        if (reviving) reviving.last_heartbeat_at = new Date().toISOString();
        const victim = arr[1 + Math.floor(Math.random() * (arr.length - 1))];
        offlineName = victim.name;
        victim.last_heartbeat_at = new Date(Date.now() - 60_000).toISOString();
      }
      setAgents([...arr]);
    }, 1500);

    return () => clearInterval(beat);
  }, []);

  return (
    <div className="shell shell-noFeed">
      <CommandBar agents={agents} now={now} demo={demo} />
      <StatPanel agents={agents} now={now} />
      <main className="main">
        <div className="grid-head">
          <h2>Agent Roster</h2>
          <span className="count">{agents.length} units · 하트비트 실시간 · 작업 흐름은 <a href="/console">콘솔</a></span>
        </div>
        <div className="agent-grid">
          {agents.map((a) => (
            <AgentTile key={a.id} agent={a} now={now} />
          ))}
        </div>
      </main>
    </div>
  );
}
