'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createBrowserClient } from '@/lib/supabase';
import { Task, TaskStatus } from '@/lib/types';

const COLS: { key: TaskStatus; label: string; color: string }[] = [
  { key: 'queued', label: 'QUEUED · 대기', color: '#4a8f6b' },
  { key: 'in_progress', label: 'RUNNING · 진행', color: '#00e5ff' },
  { key: 'done', label: 'DONE · 완료', color: '#00ff9c' },
  { key: 'failed', label: 'FAILED · 중단', color: '#ff3b6b' },
];

const DEMO_CMDS: [string, string][] = [
  ['알파조', '이번 주 유튜브 분석 리포트'],
  ['정화백', '회의록 3개 요약'],
  ['찰리조', '로그인 버그 디버깅'],
  ['델타조', 'BuzzLab 슬라이드 렌더'],
  ['소통꾼', '수강생 공지 메일 초안'],
  ['골프조', '1분기 손익표 정리'],
  ['인디아조', '경쟁사 가격 크롤링'],
];

function uid() { return Math.random().toString(36).slice(2, 9); }

export default function Console() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [demo, setDemo] = useState(false);
  const [view, setView] = useState<'kanban' | 'feed'>('kanban');
  const demoRef = useRef<Task[]>([]);

  useEffect(() => {
    const sb = createBrowserClient();

    // ── 라이브 모드 ──
    if (sb) {
      const load = async () => {
        const { data } = await sb.from('tasks').select('*').order('created_at', { ascending: false }).limit(80);
        if (data) setTasks(data as Task[]);
      };
      load();
      const poll = setInterval(load, 20000); // 실시간 끊겨도 자가 회복 (주기적 재동기화)
      const ch = sb
        .channel('console')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => load())
        .subscribe();
      return () => { clearInterval(poll); sb.removeChannel(ch); };
    }

    // ── 데모 모드 ──
    setDemo(true);
    const seed: Task[] = DEMO_CMDS.map(([who, cmd], i) => ({
      id: uid(), command_text: cmd, assigned_agent: who,
      status: (['queued', 'in_progress', 'done', 'queued'] as TaskStatus[])[i % 4],
      source_chat_id: null, result: null,
      created_at: new Date(Date.now() - i * 60000).toISOString(),
      updated_at: new Date().toISOString(),
    }));
    demoRef.current = seed;
    setTasks([...seed]);

    const tick = setInterval(() => {
      const arr = demoRef.current;
      // 대기→진행, 진행→완료/실패 전이
      const q = arr.find((t) => t.status === 'queued');
      if (q && Math.random() < 0.5) { q.status = 'in_progress'; q.updated_at = new Date().toISOString(); }
      const ip = arr.find((t) => t.status === 'in_progress');
      if (ip && Math.random() < 0.4) {
        const ok = Math.random() < 0.8;
        ip.status = ok ? 'done' : 'failed';
        ip.result = ok ? `“${ip.command_text}” 완료` : '⛔ 오류로 실패';
        ip.updated_at = new Date().toISOString();
      }
      // 가끔 새 작업
      if (Math.random() < 0.3 && arr.length < 24) {
        const [who, cmd] = DEMO_CMDS[Math.floor(Math.random() * DEMO_CMDS.length)];
        arr.unshift({ id: uid(), command_text: cmd, assigned_agent: who, status: 'queued',
          source_chat_id: null, result: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }
      setTasks([...arr]);
    }, 2500);
    return () => clearInterval(tick);
  }, []);

  async function act(action: 'cancel' | 'retry', task: Task) {
    if (demo) {
      const arr = demoRef.current;
      if (action === 'cancel') {
        const t = arr.find((x) => x.id === task.id);
        if (t) { t.status = 'failed'; t.result = '⛔ 취소됨'; t.updated_at = new Date().toISOString(); }
      } else {
        arr.unshift({ ...task, id: uid(), status: 'queued', result: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }
      setTasks([...arr]);
      return;
    }
    await fetch('/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, taskId: task.id }),
    }).catch(() => {});
  }

  const byCol = (k: TaskStatus) => tasks.filter((t) => t.status === k);

  return (
    <div className="console-shell">
      <header className="bar">
        <div className="wordmark">
          POCKET COMMAND POST · <span className="accent">CONSOLE</span>
          <span className="sub">TASK KANBAN · 작업 관제</span>
        </div>
        <nav className="nav">
          <Link href="/">관제 보드</Link>
          <Link href="/console" className="active">콘솔</Link>
        </nav>
        <div className="bar-spacer" />
        <div className="view-toggle">
          <button className={view === 'kanban' ? 'vt active' : 'vt'} onClick={() => setView('kanban')}>칸반</button>
          <button className={view === 'feed' ? 'vt active' : 'vt'} onClick={() => setView('feed')}>피드</button>
        </div>
        {demo && <span className="demo-flag">DEMO MODE</span>}
      </header>

      <div className="console-body">
        {view === 'kanban' ? (
        <div className="kanban">
          {COLS.map((col) => {
            const cards = byCol(col.key);
            return (
              <div className="col" key={col.key}>
                <div className="col-head">
                  <span style={{ color: col.color }}>{col.label}</span>
                  <span className="badge" style={{ background: col.color }}>{cards.length}</span>
                </div>
                <div className="col-cards">
                  {cards.length === 0 && <div className="col-empty">— 없음 —</div>}
                  {cards.map((t) => (
                    <div className="card2" key={t.id} style={{ borderLeftColor: col.color }}>
                      <div className="c-top">
                        <span className="c-agent">{t.assigned_agent ?? '미배정'}</span>
                        <span className="c-host">#{t.id.slice(0, 6)}</span>
                      </div>
                      <div className="c-cmd">{t.command_text}</div>
                      {t.result && <div className="c-result">{t.result}</div>}
                      <div className="c-meta">
                        {new Date(t.updated_at).toLocaleTimeString('ko-KR', { hour12: false })}
                      </div>
                      <div className="c-actions">
                        {(t.status === 'queued' || t.status === 'in_progress') && (
                          <button className="btn btn-cancel" onClick={() => act('cancel', t)}>
                            {t.status === 'in_progress' ? '중단' : '취소'}
                          </button>
                        )}
                        {(t.status === 'done' || t.status === 'failed') && (
                          <button className="btn btn-retry" onClick={() => act('retry', t)}>재시도</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        ) : (
        <div className="feed-view">
          <div className="feed-head"><span>▦ LIVE FEED · 시간순</span><span className="fv-count">{tasks.length}건</span></div>
          {tasks.length === 0 && <div className="col-empty">— 작업 없음 —</div>}
          {[...tasks].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).map((t) => {
            const col = COLS.find((c) => c.key === t.status);
            return (
              <div className="feed-row" key={t.id} style={{ borderLeftColor: col?.color || '#4a8f6b' }}>
                <span className="fr-time">{new Date(t.updated_at).toLocaleTimeString('ko-KR', { hour12: false })}</span>
                <span className="fr-agent">{t.assigned_agent ?? '미배정'}</span>
                <span className="fr-status" style={{ color: col?.color }}>{col?.label ?? t.status}</span>
                <span className="fr-cmd">{t.command_text}</span>
              </div>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
}
